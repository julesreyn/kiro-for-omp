/** Builds AWS Event Stream frames the way Kiro sends them, for tests. */

import { crc32 } from "../src/eventstream.ts"

/**
 * Encodes one event frame whose payload is `payload`, JSON-encoded unless a string.
 * `headers` adds to or overrides the event headers.
 */
export function frame(eventType: string, payload: unknown, headers: Record<string, string> = {}): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder()
  const all = { ":event-type": eventType, ":content-type": "application/json", ":message-type": "event", ...headers }
  const headerBytes = Object.entries(all).flatMap(([name, value]) => {
    const nameBytes = encoder.encode(name)
    const valueBytes = encoder.encode(value)
    return [nameBytes.length, ...nameBytes, 7, valueBytes.length >> 8, valueBytes.length & 0xff, ...valueBytes]
  })
  const body = encoder.encode(typeof payload === "string" ? payload : JSON.stringify(payload))
  const total = 12 + headerBytes.length + body.length + 4
  const bytes = new Uint8Array(total)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, total)
  view.setUint32(4, headerBytes.length)
  view.setUint32(8, crc32(bytes, 0, 8))
  bytes.set(headerBytes, 12)
  bytes.set(body, 12 + headerBytes.length)
  view.setUint32(total - 4, crc32(bytes, 0, total - 4))
  return bytes
}

export const content = (text: string) => frame("assistantResponseEvent", { content: text })
export const reasoning = (text: string) => frame("reasoningContentEvent", { text })

/** Concatenates frames into one response body. */
export function frames(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }
  return bytes
}

/** A Kiro response whose body is `parts` framed back to back. */
export function eventStream(...parts: Uint8Array[]): Response {
  return new Response(frames(...parts))
}

/** A body that delivers each of `chunks` in a separate read. */
export function chunked(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}
