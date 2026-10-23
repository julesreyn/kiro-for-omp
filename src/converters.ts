/**
 * Convert OMP's internal message format to Kiro's conversationState format.
 *
 * Kiro API expects:
 *   {
 *     conversationState: {
 *       conversationId: "uuid",
 *       chatTriggerType: "MANUAL",
 *       currentMessage: { userInputMessage: { content, modelId, origin, images?, userInputMessageContext? } },
 *       history: [ { userInputMessage: {...} }, { assistantResponseMessage: {...} } ]
 *     },
 *     profileArn?: "arn:..."
 *   }
 *
 * Key constraints:
 * - History must alternate user/assistant
 * - First message in history must be user
 * - Empty content must use placeholder "(empty placeholder)"
 * - Tool names must be ≤ 64 chars (truncated with reverse-map for response dispatch)
 * - Tool results go in userInputMessageContext.toolResults
 * - System prompt is prepended to first user message content
 */

import { randomUUID } from "node:crypto"
import type { ContextLike, ImageContent, MessageLike, ToolLike, ToolCallContent, ToolResultLike } from "./types.ts"

const KIRO_MAX_TOOL_NAME = 64
const KIRO_MAX_TOOL_DESCRIPTION = 10000
const KIRO_MAX_PAYLOAD_BYTES = 600000
const EMPTY_PLACEHOLDER = "(empty placeholder)"

/**
 * Map from truncated name back to original name. Truncation is deterministic, so the map is never
 * cleared: a request queued behind a stream must not erase the names that stream resolves.
 */
const truncationMap = new Map<string, string>()

/** Truncate tool name to Kiro's max length. Records mapping for reversal. */
function truncateToolName(name: string): string {
  if (name.length <= KIRO_MAX_TOOL_NAME) return name
  // Keep as much of the name as fits, plus a short hash suffix for uniqueness.
  const hash = simpleHash(name)
  const suffix = `_t${hash}`
  const truncated = name.slice(0, KIRO_MAX_TOOL_NAME - suffix.length) + suffix
  truncationMap.set(truncated, name)
  return truncated
}

/** Reverse-map a (possibly truncated) tool name back to the original. */
export function resolveToolName(name: string): string {
  return truncationMap.get(name) ?? name
}

/** Simple deterministic hash for short suffix generation. */
function simpleHash(str: string): string {
  let h = 0
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(16).slice(0, 4).padStart(4, "0")
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
      .filter((c) => c.type === "text")
      .map((c) => String(c.text ?? ""))
      .join("")
  }
  return String(content ?? "")
}

function imageContent(content: unknown): ImageContent[] {
  if (!Array.isArray(content)) return []
  return content
    .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
    .filter((c): c is Record<string, unknown> & ImageContent =>
      c.type === "image" && typeof c.data === "string" && typeof c.mimeType === "string",
    )
}

function toolCallBlocks(content: unknown): ToolCallContent[] {
  if (!Array.isArray(content)) return []
  return content.filter((c): c is ToolCallContent =>
    isRecord(c) && c.type === "toolCall" && typeof c.id === "string" && typeof c.name === "string",
  )
}

function imageFormat(mimeType: string): string {
  return mimeType.split("/")[1]?.toLowerCase() || "png"
}

function imagesToKiroFormat(images: ImageContent[]): unknown[] | undefined {
  if (images.length === 0) return undefined
  return images.map((img) => ({
    format: imageFormat(img.mimeType),
    source: { bytes: img.data },
  }))
}

function toolsToKiroFormat(tools?: readonly ToolLike[]): unknown[] | undefined {
  if (!tools || tools.length === 0) return undefined

  return tools.map((tool) => {
    const name = truncateToolName(tool.name)
    let description = tool.description?.trim() || `Tool: ${tool.name}`
    if (description.length > KIRO_MAX_TOOL_DESCRIPTION) {
      const suffix = "\n\n[Description truncated to fit Kiro tool metadata limit]"
      description = description.slice(0, KIRO_MAX_TOOL_DESCRIPTION - suffix.length) + suffix
    }

    // OMP passes plain JSON Schema; forward it, less the keywords Kiro rejects, so
    // property descriptions, limits, and optional fields reach the model.
    const schema = tool.parameters
    return {
      toolSpecification: {
        name,
        description,
        inputSchema: { json: isRecord(schema) ? sanitizeJsonSchema(schema) : { type: "object", properties: {} } },
      },
    }
  })
}

/**
 * Kiro rejects JSON Schema keywords accepted by OMP tool definitions with a
 * generic 400 response. Remove them recursively before sending the request.
 */
function sanitizeJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeJsonSchema)
  if (!isRecord(schema)) return schema

  const sanitized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === "additionalProperties") continue
    if (key === "required" && Array.isArray(value) && value.length === 0) continue
    // These map names to schemas, and a name may look like a keyword.
    sanitized[key] = SCHEMA_MAPS.has(key) && isRecord(value)
      ? Object.fromEntries(Object.entries(value).map(([name, child]) => [name, sanitizeJsonSchema(child)]))
      : LITERAL_KEYWORDS.has(key) ? value : sanitizeJsonSchema(value)
  }
  return sanitized
}

const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"])
const LITERAL_KEYWORDS = new Set(["const", "default", "enum", "examples"])

function toolResultsToKiroFormat(results?: ToolResultLike[]): unknown[] | undefined {
  if (!results || results.length === 0) return undefined

  return results.map((r) => ({
    toolUseId: r.toolCallId,
    content: [{ text: r.content || EMPTY_PLACEHOLDER }],
    status: r.isError ? "error" as const : "success" as const,
  }))
}

function toolCallsToKiroToolUses(
  toolCalls?: ToolCallContent[],
): unknown[] | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined

  return toolCalls.map((tc) => ({
    toolUseId: tc.id,
    name: truncateToolName(tc.name),
    input: tc.arguments,
  }))
}

// History handling is adapted from mikeyobrien/pi-provider-kiro.

/** Max history size in characters, calibrated for 200K-token context models. */
const HISTORY_LIMIT = 850000
/** The context window size that HISTORY_LIMIT was calibrated for. */
const HISTORY_LIMIT_CONTEXT_WINDOW = 200000

/**
 * Sanitize history: strip leading entries that would make history invalid, and unpair tool uses
 * and tool results that lost their partner. Unpairing keeps the entry, so user and assistant still
 * alternate. `currentHasToolResults` says whether the current message answers the last tool uses.
 */
function sanitizeHistory(history: unknown[], currentHasToolResults: boolean): unknown[] {
  // Strip leading entries that aren't valid starts
  while (
    history.length > 0 &&
    hasAssistantMessage(history[0]) &&
    !hasToolUses(history[0])
  ) {
    history = history.slice(1)
  }

  const result: unknown[] = []
  for (let i = 0; i < history.length; i++) {
    const entry = history[i]
    // Skip assistant messages with no content and no tool uses (from API errors)
    if (hasAssistantMessage(entry) && !hasToolUses(entry) && !hasContent(entry)) continue

    if (hasToolUses(entry)) {
      const answered = i + 1 < history.length ? hasToolResults(history[i + 1]) : currentHasToolResults
      result.push(answered ? entry : withoutToolUses(entry))
    } else if (hasToolResults(entry)) {
      const prev = result[result.length - 1]
      result.push(prev && hasToolUses(prev) ? entry : withoutToolResults(entry))
    } else {
      result.push(entry)
    }
  }
  return result
}

/** An assistant entry without its tool uses. */
function withoutToolUses(entry: unknown): unknown {
  const { toolUses: _toolUses, ...message } = (entry as { assistantResponseMessage: Record<string, unknown> }).assistantResponseMessage
  return { assistantResponseMessage: { ...message, content: message.content || EMPTY_PLACEHOLDER } }
}

/** A user entry whose tool results become plain text, for results with no tool use to answer. */
function withoutToolResults(entry: unknown): unknown {
  const message = (entry as { userInputMessage: Record<string, unknown> }).userInputMessage
  const { toolResults: _toolResults, ...context } = (message.userInputMessageContext ?? {}) as Record<string, unknown>
  const { userInputMessageContext: _context, ...rest } = message
  return {
    userInputMessage: {
      ...rest,
      content: withResultText(message.content, getToolResults(entry)),
      ...(Object.keys(context).length > 0 ? { userInputMessageContext: context } : {}),
    },
  }
}

/**
 * `content` followed by the text of `results`, so unpaired tool output still reaches the model.
 * Each result is labeled as tool output, so it cannot pass for the user's own words.
 */
function withResultText(content: unknown, results: unknown[]): string {
  const texts = results.map((result) => {
    const { toolUseId, status, content: parts } = result as { toolUseId?: unknown; status?: unknown; content?: Array<{ text?: unknown }> }
    const text = (parts ?? []).map((part) => String(part.text ?? "")).filter(Boolean).join("\n")
    const label = `[Output of tool call ${String(toolUseId ?? "unknown")}${status === "error" ? ", which failed" : ""}]`
    return `${label}\n${text || EMPTY_PLACEHOLDER}\n[End of tool output]`
  })
  const own = content === EMPTY_PLACEHOLDER ? "" : String(content ?? "")
  return [own, ...texts].filter(Boolean).join("\n\n") || EMPTY_PLACEHOLDER
}

/**
 * Inject synthetic tool calls for orphaned tool results (results with no
 * matching tool use ID in history). Prevents API errors.
 */
function injectSyntheticToolCalls(history: unknown[]): unknown[] {
  const validIds = new Set<string>()
  for (const entry of history) {
    const uses = getToolUses(entry)
    for (const tu of uses) {
      const id = (tu as Record<string, unknown>).toolUseId as string | undefined
      if (id) validIds.add(id)
    }
  }

  const result: unknown[] = []
  for (const entry of history) {
    const toolResults = getToolResults(entry)
    if (toolResults.length > 0) {
      const orphaned = toolResults.filter((tr) => !validIds.has((tr as Record<string, unknown>).toolUseId as string))
      if (orphaned.length > 0) {
        result.push({
          assistantResponseMessage: {
            content: "Tool calls were made.",
            toolUses: orphaned.map((tr) => ({
              name: "unknown_tool",
              toolUseId: (tr as Record<string, unknown>).toolUseId,
              input: {},
            })),
          },
        })
        for (const tr of orphaned) validIds.add((tr as Record<string, unknown>).toolUseId as string)
      }
    }
    result.push(entry)
  }
  return result
}

/**
 * Truncate history to fit within a character limit, removing oldest entries first.
 * Limit is dynamically scaled to the model's context window.
 */
function truncateHistory(history: unknown[], charLimit: number, currentHasToolResults: boolean): unknown[] {
  let sanitized = sanitizeHistory(history, currentHasToolResults)
  let size = JSON.stringify(sanitized).length
  while (size > charLimit && sanitized.length > 2) {
    sanitized.shift()
    // Re-sanitize after removal to maintain alternation
    while (sanitized.length > 0 && !hasUserMessage(sanitized[0])) sanitized.shift()
    sanitized = sanitizeHistory(sanitized, currentHasToolResults)
    size = JSON.stringify(sanitized).length
  }
  return injectSyntheticToolCalls(sanitized)
}

function hasAssistantMessage(entry: unknown): boolean {
  return isRecord(entry) && "assistantResponseMessage" in entry
}

function hasUserMessage(entry: unknown): boolean {
  return isRecord(entry) && "userInputMessage" in entry
}

function hasToolUses(entry: unknown): boolean {
  return getToolUses(entry).length > 0
}

function hasContent(entry: unknown): boolean {
  if (!isRecord(entry)) return false
  const arm = entry.assistantResponseMessage as Record<string, unknown> | undefined
  return !!arm?.content && String(arm.content).length > 0
}

function hasToolResults(entry: unknown): boolean {
  return getToolResults(entry).length > 0
}

function getToolUses(entry: unknown): unknown[] {
  if (!isRecord(entry)) return []
  const arm = entry.assistantResponseMessage as Record<string, unknown> | undefined
  return Array.isArray(arm?.toolUses) ? (arm!.toolUses as unknown[]) : []
}

function getToolResults(entry: unknown): unknown[] {
  if (!isRecord(entry)) return []
  const uim = entry.userInputMessage as Record<string, unknown> | undefined
  const ctx = uim?.userInputMessageContext as Record<string, unknown> | undefined
  return Array.isArray(ctx?.toolResults) ? (ctx!.toolResults as unknown[]) : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** One side of the conversation as Kiro sees it: OMP's consecutive messages of a role, merged. */
interface Turn {
  role: "user" | "assistant"
  text: string
  images: ImageContent[]
  toolCalls: ToolCallContent[]
  toolResults: ToolResultLike[]
}

/**
 * OMP's messages as alternating user and assistant turns. Tool calls come from the assistant's
 * `toolCall` blocks; each "toolResult" message joins the user turn that answers them, with any
 * images it returned.
 */
function toTurns(messages: readonly MessageLike[]): Turn[] {
  const turns: Turn[] = []
  for (const msg of messages) {
    const turn: Turn = msg.role === "toolResult"
      ? {
          role: "user",
          text: "",
          images: imageContent(msg.content),
          toolCalls: [],
          toolResults: [{ toolCallId: msg.toolCallId ?? "", content: textContent(msg.content), isError: msg.isError }],
        }
      : {
          role: msg.role,
          text: textContent(msg.content),
          images: msg.role === "user" ? imageContent(msg.content) : [],
          toolCalls: [...toolCallBlocks(msg.content), ...(msg.toolCalls ?? [])],
          toolResults: [...(msg.toolResults ?? [])],
        }
    const last = turns[turns.length - 1]
    if (last?.role === turn.role) {
      last.text = [last.text, turn.text].filter(Boolean).join("\n")
      last.images.push(...turn.images)
      last.toolCalls.push(...turn.toolCalls)
      last.toolResults.push(...turn.toolResults)
    } else {
      turns.push(turn)
    }
  }
  return turns
}

function buildHistory(
  messages: readonly MessageLike[],
  modelId: string,
  systemPrompt: string,
): { history: unknown[]; currentContent: string; currentImages?: unknown[]; currentToolResults?: unknown[] } {
  const turns = toTurns(messages)
  if (turns.length === 0) {
    return { history: [], currentContent: systemPrompt || EMPTY_PLACEHOLDER }
  }

  // All turns except the last go into history
  const historyTurns = turns.slice(0, -1)
  const lastTurn = turns[turns.length - 1]

  const history: unknown[] = []

  let systemInjected = false

  for (const turn of historyTurns) {
    let content = turn.text

    if (turn.role === "user" && !systemInjected && systemPrompt) {
      content = `${systemPrompt}\n\n${content}`
      systemInjected = true
    }

    if (!content) content = EMPTY_PLACEHOLDER

    if (turn.role === "user") {
      const userMsg: Record<string, unknown> = {
        content,
        modelId,
        origin: "AI_EDITOR",
      }

      const images = imagesToKiroFormat(turn.images)
      if (images) userMsg.images = images

      const toolResults = toolResultsToKiroFormat(turn.toolResults)
      if (toolResults) {
        userMsg.userInputMessageContext = { toolResults }
      }

      history.push({ userInputMessage: userMsg })
    } else {
      const assistantMsg: Record<string, unknown> = { content }

      const toolUses = toolCallsToKiroToolUses(turn.toolCalls)
      if (toolUses) {
        assistantMsg.toolUses = toolUses
      }

      history.push({ assistantResponseMessage: assistantMsg })
    }
  }

  // Turns already alternate; this only puts a user turn first when history starts with the assistant.
  const normalized = enforceAlternation(history, modelId)

  let currentContent = lastTurn.text

  // With no user turn in history, the system prompt goes on the current message.
  if (!systemInjected && systemPrompt) {
    currentContent = `${systemPrompt}\n\n${currentContent}`
  }

  if (!currentContent) currentContent = EMPTY_PLACEHOLDER

  const currentImages = lastTurn.role === "user" ? imagesToKiroFormat(lastTurn.images) : undefined
  const currentToolResults = lastTurn.role === "user" ? toolResultsToKiroFormat(lastTurn.toolResults) : undefined

  return { history: normalized, currentContent, currentImages, currentToolResults }
}

/**
 * Enforce Kiro's history alternation constraint:
 * - History must alternate user/assistant
 * - First message must be user
 *
 * Strategy:
 * - If history starts with assistant, prepend a synthetic user message
 * - Merge consecutive same-role messages by concatenating content
 */
function enforceAlternation(history: unknown[], modelId: string): unknown[] {
  if (history.length === 0) return history

  const result: unknown[] = []
  const syntheticUser = { userInputMessage: { content: "(continued)", modelId, origin: "AI_EDITOR" } }

  if ("assistantResponseMessage" in (history[0] as Record<string, unknown>)) {
    result.push(syntheticUser)
  }

  for (const entry of history) {
    const last = result[result.length - 1] as Record<string, unknown> | undefined
    const entryIsUser = "userInputMessage" in (entry as Record<string, unknown>)

    if (last) {
      const lastIsUser = "userInputMessage" in last
      // Same role — merge content into the last entry
      if (lastIsUser === entryIsUser) {
        const lastMsgKey = lastIsUser ? "userInputMessage" : "assistantResponseMessage"
        const curMsgKey = entryIsUser ? "userInputMessage" : "assistantResponseMessage"
        const lastMsg = last[lastMsgKey] as Record<string, unknown>
        const curMsg = (entry as Record<string, unknown>)[curMsgKey] as Record<string, unknown>
        if (lastMsg && curMsg) {
          lastMsg.content = `${lastMsg.content ?? ""}\n${curMsg.content ?? ""}`
          if (curMsg.images) {
            lastMsg.images = [...((lastMsg.images as unknown[]) ?? []), ...(curMsg.images as unknown[])]
          }
          // Merge toolUses if present (assistant) or toolResults if present (user)
          if (curMsg.toolUses) {
            const existing = (lastMsg.toolUses as unknown[]) ?? []
            lastMsg.toolUses = [...existing, ...(curMsg.toolUses as unknown[])]
          }
          if (curMsg.userInputMessageContext) {
            const existingCtx = (lastMsg.userInputMessageContext as Record<string, unknown>) ?? {}
            const curCtx = curMsg.userInputMessageContext as Record<string, unknown>
            const existingTR = (existingCtx.toolResults as unknown[]) ?? []
            const curTR = (curCtx.toolResults as unknown[]) ?? []
            if (curTR.length > 0) {
              lastMsg.userInputMessageContext = { ...existingCtx, toolResults: [...existingTR, ...curTR] }
            }
          }
        }
        continue
      }
    }

    result.push(entry)
  }

  return result
}

export interface KiroPayload {
  conversationState: {
    conversationId: string
    chatTriggerType: "MANUAL"
    agentTaskType: "vibe"
    currentMessage: {
      userInputMessage: Record<string, unknown>
    }
    history?: unknown[]
  }
  profileArn?: string
  agentMode?: string
  additionalModelRequestFields?: Record<string, { effort: string }>
}

/** OMP 18 sends the system prompt as blocks (main prompt, project context); keep them apart. */
export function systemPromptText(prompt?: string | readonly string[]): string {
  return typeof prompt === "string" ? prompt : (prompt ?? []).filter(Boolean).join("\n\n")
}

export function buildKiroPayload(
  modelId: string,
  context: ContextLike,
  profileArn?: string,
  contextWindow?: number,
): KiroPayload {
  // OMP selectors use dash-form versions; Kiro's API expects dot-form.
  const kiroModelId = modelId.replace(/(\d)-(\d)(?!\d)/g, "$1.$2")
  let { history, currentContent, currentImages, currentToolResults } = buildHistory(
    context.messages,
    kiroModelId,
    systemPromptText(context.systemPrompt),
  )

  // Scale the history limit to the model's context window.
  if (history.length > 0 && contextWindow) {
    const dynamicLimit = Math.floor((contextWindow / HISTORY_LIMIT_CONTEXT_WINDOW) * HISTORY_LIMIT)
    history = truncateHistory(history, dynamicLimit, !!currentToolResults)
  }

  const userInputMessage: Record<string, unknown> = {
    content: currentContent,
    modelId: kiroModelId,
    origin: "KIRO_CLI",
  }
  if (currentImages) userInputMessage.images = currentImages

  const userCtx: Record<string, unknown> = {}
  const kiroTools = toolsToKiroFormat(context.tools)
  if (kiroTools) userCtx.tools = kiroTools
  if (currentToolResults) userCtx.toolResults = currentToolResults
  if (Object.keys(userCtx).length > 0) {
    userInputMessage.userInputMessageContext = userCtx
  }

  const payload: KiroPayload = {
    conversationState: {
      conversationId: randomUUID(),
      chatTriggerType: "MANUAL",
      agentTaskType: "vibe",
      currentMessage: { userInputMessage },
    },
    agentMode: "vibe",
  }

  if (history.length > 0) {
    payload.conversationState.history = history
  }

  if (profileArn) {
    payload.profileArn = profileArn
  }

  trimPayloadHistory(payload)

  return payload
}

function trimPayloadHistory(payload: KiroPayload): void {
  const size = () => Buffer.byteLength(JSON.stringify(payload), "utf8")
  const history = payload.conversationState.history

  while (history && history.length > 2 && size() > KIRO_MAX_PAYLOAD_BYTES) {
    history.shift()
    while (history.length > 0 && !hasUserMessage(history[0])) history.shift()
    // The tool uses these results answered are gone.
    if (hasToolResults(history[0])) history[0] = withoutToolResults(history[0])
  }

  if (history?.length === 0) delete payload.conversationState.history
  unpairCurrentToolResults(payload)

  const finalSize = size()
  if (finalSize > KIRO_MAX_PAYLOAD_BYTES) {
    throw new Error(
      `Kiro request payload is ${finalSize} bytes, above the ${KIRO_MAX_PAYLOAD_BYTES}-byte safe limit`,
    )
  }
}

/** Current tool results that answer no tool use in the last history entry become plain text. */
function unpairCurrentToolResults(payload: KiroPayload): void {
  const current = payload.conversationState.currentMessage.userInputMessage
  const context = current.userInputMessageContext as Record<string, unknown> | undefined
  const results = Array.isArray(context?.toolResults) ? context.toolResults as Array<{ toolUseId?: unknown }> : []
  if (!context || results.length === 0) return

  const history = payload.conversationState.history ?? []
  const asked = new Set(getToolUses(history[history.length - 1]).map((use) => (use as { toolUseId?: unknown }).toolUseId))
  const unpaired = results.filter((result) => !asked.has(result.toolUseId))
  if (unpaired.length === 0) return

  const paired = results.filter((result) => asked.has(result.toolUseId))
  if (paired.length > 0) context.toolResults = paired
  else delete context.toolResults
  if (Object.keys(context).length === 0) delete current.userInputMessageContext
  current.content = withResultText(current.content, unpaired)
}
