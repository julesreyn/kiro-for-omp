/**
 * AWS Event Stream decoder for Kiro API responses.
 *
 * `generateAssistantResponse` answers with binary AWS Event Stream frames:
 *
 *   totalLen u32 | headersLen u32 | preludeCRC u32 | headers | payload | messageCRC u32
 *
 * Each frame's `:event-type` header names the `ChatResponseStream` member it
 * carries, so events are routed on that header, never on the payload's shape.
 * Unknown members are ignored instead of leaking into the transcript. Frames
 * with a bad length or CRC are skipped by resynchronising one byte at a time.
 */

export interface ContentEvent {
  type: "content"
  content: string
}

export interface ToolStartEvent {
  type: "tool_start"
  toolUseId: string
  name: string
  input: string
  stop: boolean
}

export interface ToolInputEvent {
  type: "tool_input"
  input: string
}

export interface ToolStopEvent {
  type: "tool_stop"
  stop: boolean
}

export interface UsageEvent {
  type: "usage"
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  reasoningTokens?: number
}

export interface ContextUsageEvent {
  type: "context_usage"
  percentage: number
}

/** Readable reasoning streamed as `reasoningContentEvent.text`. */
export interface ReasoningEvent {
  type: "reasoning"
  text: string
}

/** `reasoningContentEvent.redactedContent`: the model reasoned, but the provider hides it. */
export interface ReasoningRedactedEvent {
  type: "reasoning_redacted"
}

/** An exception frame, or an error member delivered as an event. */
export interface StreamErrorEvent {
  type: "error"
  errorType: string
  message: string
}

export type KiroEvent =
  | ContentEvent
  | ReasoningEvent
  | ReasoningRedactedEvent
  | ToolStartEvent
  | ToolInputEvent
  | ToolStopEvent
  | UsageEvent
  | ContextUsageEvent
  | StreamErrorEvent

const PRELUDE_BYTES = 12
const MESSAGE_CRC_BYTES = 4
const MIN_FRAME_BYTES = PRELUDE_BYTES + MESSAGE_CRC_BYTES
// A frame claiming more than this is treated as corruption.
const MAX_FRAME_BYTES = 16 * 1024 * 1024

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let crc = 0xffffffff
  for (let i = start; i < end; i++) crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

const HEADER_TYPE_BYTES = 6
const HEADER_TYPE_STRING = 7
// Value sizes for the fixed-width header types (0/1 are booleans with no value bytes).
const FIXED_HEADER_SIZES: Record<number, number> = { 0: 0, 1: 0, 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 }

/** String headers by name. Other value types are skipped by length. */
function parseHeaders(bytes: Uint8Array, start: number, end: number, decoder: TextDecoder): Record<string, string> {
  const headers: Record<string, string> = {}
  let i = start
  while (i < end) {
    const nameLength = bytes[i++]
    if (i + nameLength + 1 > end) break
    const name = decoder.decode(bytes.subarray(i, i + nameLength))
    i += nameLength
    const valueType = bytes[i++]
    if (valueType === HEADER_TYPE_STRING || valueType === HEADER_TYPE_BYTES) {
      if (i + 2 > end) break
      const length = (bytes[i] << 8) | bytes[i + 1]
      i += 2
      if (i + length > end) break
      if (valueType === HEADER_TYPE_STRING) headers[name] = decoder.decode(bytes.subarray(i, i + length))
      i += length
    } else if (valueType in FIXED_HEADER_SIZES) {
      i += FIXED_HEADER_SIZES[valueType]
    } else {
      break
    }
  }
  return headers
}

const ERROR_MEMBERS = new Set(["error", "throttlingError", "validationError", "serviceUnavailableError"])

export class AwsEventStreamParser {
  private buffer = new Uint8Array(0)
  private readonly decoder = new TextDecoder("utf-8", { fatal: false })
  // toolUseId of the tool call whose input is still streaming; "" when it came without one.
  private openToolUseId: string | null = null
  /** Calls already stopped in this response. */
  private readonly closedToolUseIds = new Set<string>()

  /** Feed a chunk of the response body. Returns the events of every complete frame. */
  feed(chunk: Uint8Array): KiroEvent[] {
    if (this.buffer.length === 0) {
      this.buffer = chunk.slice()
    } else {
      const combined = new Uint8Array(this.buffer.length + chunk.length)
      combined.set(this.buffer)
      combined.set(chunk, this.buffer.length)
      this.buffer = combined
    }

    const events: KiroEvent[] = []
    for (;;) {
      const bytes = this.buffer
      if (bytes.length < PRELUDE_BYTES) break
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      const totalLength = view.getUint32(0)
      const headersLength = view.getUint32(4)
      if (
        totalLength < MIN_FRAME_BYTES
        || totalLength > MAX_FRAME_BYTES
        || PRELUDE_BYTES + headersLength > totalLength - MESSAGE_CRC_BYTES
        || crc32(bytes, 0, 8) !== view.getUint32(8)
      ) {
        this.buffer = bytes.subarray(1)
        continue
      }
      if (bytes.length < totalLength) break
      if (crc32(bytes, 0, totalLength - MESSAGE_CRC_BYTES) !== view.getUint32(totalLength - MESSAGE_CRC_BYTES)) {
        this.buffer = bytes.subarray(1)
        continue
      }

      const headersEnd = PRELUDE_BYTES + headersLength
      const headers = parseHeaders(bytes, PRELUDE_BYTES, headersEnd, this.decoder)
      const payload = this.decoder.decode(bytes.subarray(headersEnd, totalLength - MESSAGE_CRC_BYTES))
      this.buffer = bytes.subarray(totalLength)
      events.push(...this.mapFrame(headers, payload))
    }
    return events
  }

  private mapFrame(headers: Record<string, string>, payload: string): KiroEvent[] {
    const messageType = headers[":message-type"]
    if (messageType === "error") {
      return [{ type: "error", errorType: headers[":error-code"] ?? "error", message: headers[":error-message"] ?? payload }]
    }

    const data = parseObject(payload)
    if (messageType === "exception") {
      return [errorEvent(headers[":exception-type"] ?? headers[":event-type"] ?? "exception", data, payload)]
    }

    const eventType = headers[":event-type"] ?? ""
    if (ERROR_MEMBERS.has(eventType)) return [errorEvent(eventType, data, payload)]
    if (!data) return []

    switch (eventType) {
      case "assistantResponseEvent": {
        const content = typeof data.content === "string" ? data.content : ""
        return content ? [{ type: "content", content }] : []
      }

      case "reasoningContentEvent": {
        if (typeof data.text === "string") return data.text ? [{ type: "reasoning", text: data.text }] : []
        // The redacted blob is opaque provider data, never text to show.
        return data.redactedContent !== undefined ? [{ type: "reasoning_redacted" }] : []
      }

      case "toolUseEvent":
        return this.mapToolUse(data)

      case "contextUsageEvent": {
        const percentage = finiteNumber(data.contextUsagePercentage)
        return percentage === undefined ? [] : [{ type: "context_usage", percentage }]
      }

      case "metadataEvent": {
        const usage = asRecord(data.tokenUsage)
        if (!usage) return []
        const events: KiroEvent[] = []
        const event: UsageEvent = {
          type: "usage",
          inputTokens: finiteNumber(usage.uncachedInputTokens ?? usage.inputTokens),
          outputTokens: finiteNumber(usage.outputTokens),
          cacheReadTokens: finiteNumber(usage.cacheReadInputTokens),
          cacheCreationTokens: finiteNumber(usage.cacheWriteInputTokens),
          reasoningTokens: finiteNumber(usage.reasoningTokens),
        }
        if (Object.values(event).some((value) => typeof value === "number")) events.push(event)
        const percentage = finiteNumber(usage.contextUsagePercentage)
        if (percentage !== undefined) events.push({ type: "context_usage", percentage })
        return events
      }

      // meteringEvent counts credits, not tokens or dollars; other members carry nothing to render.
      default:
        return []
    }
  }

  /**
   * Kiro streams one tool call over several frames: the first names it, the
   * following ones carry input fragments, and the last carries `stop: true`.
   * Every frame repeats `toolUseId`, so a new id is what starts a new call.
   */
  private mapToolUse(data: Record<string, unknown>): KiroEvent[] {
    const toolUseId = typeof data.toolUseId === "string" ? data.toolUseId : ""
    const name = typeof data.name === "string" ? data.name : ""
    const input = toolInput(data.input)
    const stop = data.stop === true

    // A frame repeated after its call stopped must not start a second, nameless call.
    if (toolUseId && this.closedToolUseIds.has(toolUseId)) return []

    const startsCall = toolUseId ? toolUseId !== this.openToolUseId : this.openToolUseId === null && name !== ""
    if (startsCall) {
      this.openToolUseId = stop ? null : toolUseId
      if (stop && toolUseId) this.closedToolUseIds.add(toolUseId)
      return [{ type: "tool_start", toolUseId, name, input, stop }]
    }

    const events: KiroEvent[] = []
    if (input) events.push({ type: "tool_input", input })
    if (stop) {
      if (this.openToolUseId) this.closedToolUseIds.add(this.openToolUseId)
      this.openToolUseId = null
      events.push({ type: "tool_stop", stop: true })
    }
    return events
  }
}

function errorEvent(errorType: string, data: Record<string, unknown> | undefined, payload: string): StreamErrorEvent {
  const message = typeof data?.message === "string" ? data.message : typeof data?.Message === "string" ? data.Message : payload
  const reason = typeof data?.reason === "string" && !message.includes(data.reason) ? ` (${data.reason})` : ""
  return { type: "error", errorType, message: `${message}${reason}` }
}

function toolInput(raw: unknown): string {
  if (typeof raw === "string") return raw
  return asRecord(raw) && Object.keys(raw as object).length > 0 ? JSON.stringify(raw) : ""
}

function parseObject(payload: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(payload))
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}
