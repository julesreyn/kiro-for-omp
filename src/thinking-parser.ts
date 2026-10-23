/**
 * Stateful parser for thinking tags in streaming content.
 *
 * Separates `<thinking>`, `<reasoning>`, and `<thought>` blocks from regular
 * text, emitting proper `thinking_start`/`thinking_delta`/`thinking_end` and
 * `text_start`/`text_delta` events. Adapted from mikeyobrien/pi-provider-kiro.
 *
 * Handles split tags across chunks and reorders blocks when thinking arrives
 * after text (Kiro API behavior).
 */

import type {
  AssistantMessageEvent,
  AssistantMessageLike,
  TextContent,
  ThinkingContent,
} from "./types.ts"

const THINKING_TAG_VARIANTS: ReadonlyArray<{ open: string; close: string }> = [
  { open: "<thinking>", close: "</thinking>" },
  { open: "\u2684", close: "\u2685" }, // die-face delimiters some models use
  { open: "<reasoning>", close: "</reasoning>" },
  { open: "<thought>", close: "</thought>" },
]

function getTrailingPossibleTagPrefixLength(text: string, tag: string): number {
  const maxPrefixLength = Math.min(text.length, tag.length - 1)
  for (let len = maxPrefixLength; len > 0; len--) {
    if (text.endsWith(tag.slice(0, len))) return len
  }
  return 0
}

function getMaxTrailingPossibleTagPrefixLength(text: string, tags: string[]): number {
  let maxLength = 0
  for (const tag of tags) {
    maxLength = Math.max(maxLength, getTrailingPossibleTagPrefixLength(text, tag))
  }
  return maxLength
}

export class ThinkingTagParser {
  private textBuffer = ""
  private inThinking = false
  private thinkingExtracted = false
  private thinkingBlockIndex: number | null = null
  private textBlockIndex: number | null = null
  private lastTextBlockIndex: number | null = null
  private activeEndTag = "</thinking>"
  private output: AssistantMessageLike
  private emitEvent: (event: AssistantMessageEvent) => void

  constructor(
    output: AssistantMessageLike,
    emitEvent: (event: AssistantMessageEvent) => void,
  ) {
    this.output = output
    this.emitEvent = emitEvent
  }

  processChunk(chunk: string): void {
    this.textBuffer += chunk
    while (this.textBuffer.length > 0) {
      const prevLength = this.textBuffer.length
      if (!this.inThinking && !this.thinkingExtracted) {
        this.processBeforeThinking()
        if (this.textBuffer.length === 0) break
      }
      if (this.inThinking) {
        this.processInsideThinking()
        if (this.textBuffer.length === 0) break
      }
      if (this.thinkingExtracted) {
        this.processAfterThinking()
        break
      }
      // Guard against infinite loop when no progress is made
      if (this.textBuffer.length >= prevLength) break
    }
  }

  /** Finalize any remaining buffered text. Call when stream ends. */
  finalize(): void {
    if (this.textBuffer.length === 0) return
    if (this.inThinking && this.thinkingBlockIndex !== null) {
      // Stream ended mid-thinking — flush remaining as thinking
      const block = this.output.content[this.thinkingBlockIndex] as ThinkingContent
      block.thinking += this.textBuffer
      this.emitEvent({
        type: "thinking_delta",
        contentIndex: this.thinkingBlockIndex,
        delta: this.textBuffer,
        partial: this.output,
      })
      this.emitEvent({
        type: "thinking_end",
        contentIndex: this.thinkingBlockIndex,
        content: block.thinking,
        partial: this.output,
      })
    } else {
      this.emitText(this.textBuffer)
    }
    this.textBuffer = ""
  }

  /** Index of the answer text block, or null when there is none. */
  getTextBlockIndex(): number | null {
    return this.textBlockIndex ?? this.lastTextBlockIndex
  }

  private processBeforeThinking(): void {
    // Find the earliest opening tag across all variants
    let bestPos = -1
    let bestVariant: (typeof THINKING_TAG_VARIANTS)[number] | null = null
    for (const variant of THINKING_TAG_VARIANTS) {
      const pos = this.textBuffer.indexOf(variant.open)
      if (pos !== -1 && (bestPos === -1 || pos < bestPos)) {
        bestPos = pos
        bestVariant = variant
      }
    }

    if (bestPos !== -1 && bestVariant) {
      if (bestPos > 0) this.emitText(this.textBuffer.slice(0, bestPos))
      this.textBuffer = this.textBuffer.slice(bestPos + bestVariant.open.length)
      this.activeEndTag = bestVariant.close
      this.inThinking = true
      return
    }

    // No full tag found — check for partial tag at buffer boundary
    const trailingPrefixLength = getMaxTrailingPossibleTagPrefixLength(
      this.textBuffer,
      THINKING_TAG_VARIANTS.map((v) => v.open),
    )
    const safeLen = this.textBuffer.length - trailingPrefixLength
    if (safeLen > 0) {
      this.emitText(this.textBuffer.slice(0, safeLen))
      this.textBuffer = this.textBuffer.slice(safeLen)
    }
  }

  private processInsideThinking(): void {
    const endPos = this.textBuffer.indexOf(this.activeEndTag)
    if (endPos !== -1) {
      if (endPos > 0) this.emitThinking(this.textBuffer.slice(0, endPos))
      if (this.thinkingBlockIndex !== null) {
        const block = this.output.content[this.thinkingBlockIndex] as ThinkingContent
        this.emitEvent({
          type: "thinking_end",
          contentIndex: this.thinkingBlockIndex,
          content: block.thinking,
          partial: this.output,
        })
      }
      this.textBuffer = this.textBuffer.slice(endPos + this.activeEndTag.length)
      this.inThinking = false
      this.thinkingExtracted = true
      this.lastTextBlockIndex = this.textBlockIndex
      this.textBlockIndex = null
      // Strip leading newlines after thinking block
      if (this.textBuffer.startsWith("\n\n")) this.textBuffer = this.textBuffer.slice(2)
      return
    }

    // No full close tag — emit safe prefix, keep potential partial tag
    const trailingPrefixLength = getTrailingPossibleTagPrefixLength(this.textBuffer, this.activeEndTag)
    const safeLen = this.textBuffer.length - trailingPrefixLength
    if (safeLen > 0) {
      this.emitThinking(this.textBuffer.slice(0, safeLen))
      this.textBuffer = this.textBuffer.slice(safeLen)
    }
  }

  private processAfterThinking(): void {
    // Only the first thinking block is extracted; everything after it is answer text.
    this.emitText(this.textBuffer)
    this.textBuffer = ""
  }

  private emitText(text: string): void {
    if (!text) return
    if (this.textBlockIndex === null) {
      this.textBlockIndex = this.output.content.length
      this.output.content.push({ type: "text", text: "" })
      this.emitEvent({ type: "text_start", contentIndex: this.textBlockIndex, partial: this.output })
    }
    const block = this.output.content[this.textBlockIndex] as TextContent
    block.text += text
    this.emitEvent({ type: "text_delta", contentIndex: this.textBlockIndex, delta: text, partial: this.output })
  }

  private emitThinking(thinking: string): void {
    if (!thinking) return
    if (this.thinkingBlockIndex === null) {
      // Thinking arrived after text was already emitted (Kiro sends text before thinking).
      // Splice the thinking block before the text block so order is thinking → text.
      if (this.textBlockIndex !== null) {
        this.thinkingBlockIndex = this.textBlockIndex
        this.output.content.splice(this.thinkingBlockIndex, 0, { type: "thinking", thinking: "" })
        this.textBlockIndex = this.thinkingBlockIndex + 1
      } else {
        this.thinkingBlockIndex = this.output.content.length
        this.output.content.push({ type: "thinking", thinking: "" })
      }
      this.emitEvent({ type: "thinking_start", contentIndex: this.thinkingBlockIndex, partial: this.output })
    }
    const block = this.output.content[this.thinkingBlockIndex] as ThinkingContent
    block.thinking += thinking
    this.emitEvent({
      type: "thinking_delta",
      contentIndex: this.thinkingBlockIndex,
      delta: thinking,
      partial: this.output,
    })
  }
}
