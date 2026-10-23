/**
 * Push-based event stream implementation.
 *
 * The OMP runtime consumes events via async iteration; this class bridges
 * push-based producers (our stream parser) to that interface.
 */

import type {
  AssistantMessageEvent,
  AssistantMessageEventStreamLike,
  AssistantMessageLike,
} from "./types.ts"

class KiroEventStream implements AssistantMessageEventStreamLike {
  private readonly queue: AssistantMessageEvent[] = []
  private readonly waiting: Array<{
    resolve: (value: IteratorResult<AssistantMessageEvent>) => void
  }> = []
  private done = false
  private readonly finalResultPromise: Promise<AssistantMessageLike>
  private resolveFinalResult!: (result: AssistantMessageLike) => void

  constructor() {
    this.finalResultPromise = new Promise((resolve) => {
      this.resolveFinalResult = resolve
    })
  }

  push(event: AssistantMessageEvent): void {
    if (this.done) return

    if (event.type === "done" || event.type === "error") {
      this.done = true
      this.resolveFinalResult(event.type === "done" ? event.message : event.error)
    }

    const waiter = this.waiting.shift()
    if (waiter) {
      waiter.resolve({ value: event, done: false })
    } else {
      this.queue.push(event)
    }
  }

  end(result?: AssistantMessageLike): void {
    this.done = true
    if (result) this.resolveFinalResult(result)
    while (this.waiting.length > 0) {
      this.waiting.shift()!.resolve({ value: undefined, done: true })
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
    while (true) {
      const next = this.queue.shift()
      if (next) {
        yield next
      } else if (this.done) {
        return
      } else {
        const event = await new Promise<IteratorResult<AssistantMessageEvent>>((resolve) => {
          this.waiting.push({ resolve })
        })
        if (event.done) return
        yield event.value
      }
    }
  }

  result(): Promise<AssistantMessageLike> {
    return this.finalResultPromise
  }
}

export function createAssistantMessageEventStream(): AssistantMessageEventStreamLike {
  return new KiroEventStream()
}
