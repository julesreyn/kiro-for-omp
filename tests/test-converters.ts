/**
 * Tests for the pure request and response helpers: payload building, event stream decoding,
 * thinking tags, and bracket-style tool calls.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { buildKiroPayload, resolveToolName } from "../src/converters.ts"
import { AwsEventStreamParser, type KiroEvent } from "../src/eventstream.ts"
import { resolveReasoningLevel } from "../src/core.ts"
import { ThinkingTagParser } from "../src/thinking-parser.ts"
import { parseBracketToolCalls } from "../src/bracket-tool-parser.ts"
import type { AssistantMessageEvent, AssistantMessageLike, ContextLike } from "../src/types.ts"
import { content, frame, frames, reasoning } from "./event-frames.ts"

describe("buildKiroPayload", () => {
  it("builds minimal single-message payload", () => {
    const ctx: ContextLike = {
      systemPrompt: "You are helpful.",
      messages: [{ role: "user", content: "Hello" }],
      tools: [],
    }

    const payload = buildKiroPayload("claude-sonnet-4-5", ctx)

    assert.ok(payload.conversationState)
    assert.ok(payload.conversationState.currentMessage)
    assert.ok(payload.conversationState.currentMessage.userInputMessage)
    assert.equal(payload.conversationState.chatTriggerType, "MANUAL")

    const userInput = payload.conversationState.currentMessage.userInputMessage as Record<string, unknown>
    // With no history, the system prompt goes on the current message.
    assert.ok(String(userInput.content).includes("You are helpful."))
    assert.ok(String(userInput.content).includes("Hello"))
    assert.equal(userInput.modelId, "claude-sonnet-4.5")
    assert.equal(userInput.origin, "KIRO_CLI")
  })

  // OMP 18 passes the system prompt as blocks: the main prompt, then project context.
  it("keeps system prompt blocks apart", () => {
    const payload = buildKiroPayload("claude-sonnet-4-5", {
      systemPrompt: ["Main prompt.", "<project-context>repo</project-context>"],
      messages: [{ role: "user", content: "Hello" }],
    })

    const userInput = payload.conversationState.currentMessage.userInputMessage as Record<string, unknown>
    assert.equal(userInput.content, "Main prompt.\n\n<project-context>repo</project-context>\n\nHello")
  })

  it("gives the synthetic leading user message the real model id", () => {
    const ctx: ContextLike = {
      messages: [
        { role: "assistant", content: [{ type: "text", text: "earlier answer" }] },
        { role: "user", content: "Hello" },
      ],
      tools: [],
    }

    const payload = buildKiroPayload("claude-opus-5-5", ctx)

    const history = payload.conversationState.history as Array<{ userInputMessage?: Record<string, unknown> }>
    assert.equal(history[0].userInputMessage?.content, "(continued)")
    assert.equal(history[0].userInputMessage?.modelId, "claude-opus-5.5")
  })

  it("converts new dotted Kiro model versions without changing suffixes", () => {
    const ctx: ContextLike = { messages: [{ role: "user", content: "Hello" }], tools: [] }

    const gpt = buildKiroPayload("gpt-5-6-sol", ctx)
    const claude = buildKiroPayload("claude-sonnet-4-6-1m", ctx)

    assert.equal(gpt.conversationState.currentMessage.userInputMessage.modelId, "gpt-5.6-sol")
    assert.equal(claude.conversationState.currentMessage.userInputMessage.modelId, "claude-sonnet-4.6-1m")
  })

  it("builds multi-turn payload with history", () => {
    const ctx: ContextLike = {
      systemPrompt: "System prompt",
      messages: [
        { role: "user", content: "First message" },
        { role: "assistant", content: "First reply" },
        { role: "user", content: "Second message" },
      ],
      tools: [],
    }

    const payload = buildKiroPayload("claude_sonnet_4_5", ctx)

    assert.ok(payload.conversationState.history)
    const history = payload.conversationState.history as unknown[]

    assert.equal(history.length, 2)

    const firstHist = history[0] as Record<string, unknown>
    assert.ok(firstHist.userInputMessage)
    const firstUser = firstHist.userInputMessage as Record<string, unknown>
    assert.ok(String(firstUser.content).includes("System prompt"))
    assert.ok(String(firstUser.content).includes("First message"))

    const secondHist = history[1] as Record<string, unknown>
    assert.ok(secondHist.assistantResponseMessage)

    const current = payload.conversationState.currentMessage.userInputMessage as Record<string, unknown>
    assert.equal(current.content, "Second message")
  })

  it("includes tools in userInputMessageContext", () => {
    const ctx: ContextLike = {
      systemPrompt: undefined,
      messages: [{ role: "user", content: "Use a tool" }],
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    }

    const payload = buildKiroPayload("claude_sonnet_4_5", ctx)
    const current = payload.conversationState.currentMessage.userInputMessage as Record<string, unknown>

    assert.ok(current.userInputMessageContext)
    const userCtx = current.userInputMessageContext as Record<string, unknown>
    assert.ok(userCtx.tools)
    const tools = userCtx.tools as unknown[]
    assert.equal(tools.length, 1)
    const spec = (tools[0] as Record<string, unknown>).toolSpecification as Record<string, unknown>
    assert.equal(spec.name, "read_file")
    assert.ok(spec.inputSchema)
    assert.ok((spec.inputSchema as Record<string, unknown>).json)
  })

  it("truncates tool names > 64 chars", () => {
    const longName = "a".repeat(100)
    const ctx: ContextLike = {
      systemPrompt: undefined,
      messages: [{ role: "user", content: "test" }],
      tools: [{ name: longName, description: "desc", parameters: {} }],
    }

    const payload = buildKiroPayload("claude_sonnet_4_5", ctx)
    const current = payload.conversationState.currentMessage.userInputMessage as Record<string, unknown>
    const userCtx = current.userInputMessageContext as Record<string, unknown>
    const tools = userCtx.tools as unknown[]
    assert.equal(tools.length, 1)
    const spec = (tools[0] as Record<string, unknown>).toolSpecification as Record<string, unknown>
    assert.equal(spec.name.length, 64)
  })

  it("sanitizes schemas and supplies a non-empty tool description", () => {
    const ctx: ContextLike = {
      messages: [{ role: "user", content: "test" }],
      tools: [{
        name: "strict_tool",
        description: "",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: [],
          properties: {
            nested: {
              type: "object",
              additionalProperties: false,
              required: [],
            },
          },
        },
      }],
    }

    const payload = buildKiroPayload("model", ctx)
    const current = payload.conversationState.currentMessage.userInputMessage
    const userCtx = current.userInputMessageContext as Record<string, unknown>
    const tools = userCtx.tools as Array<Record<string, unknown>>
    const spec = tools[0].toolSpecification as Record<string, unknown>
    const schema = (spec.inputSchema as Record<string, unknown>).json as Record<string, unknown>
    const nested = (schema.properties as Record<string, Record<string, unknown>>).nested

    assert.equal(spec.description, "Tool: strict_tool")
    assert.ok(!("additionalProperties" in schema))
    assert.ok(!("required" in schema))
    assert.ok(!("additionalProperties" in nested))
    assert.ok(!("required" in nested))
  })

  it("truncates overlong tool descriptions without contaminating the user prompt", () => {
    const longDescription = "A".repeat(10001)
    const payload = buildKiroPayload("model", {
      messages: [{ role: "user", content: "test" }],
      tools: [{ name: "documented_tool", description: longDescription, parameters: {} }],
    })
    const current = payload.conversationState.currentMessage.userInputMessage
    const userCtx = current.userInputMessageContext as Record<string, unknown>
    const tools = userCtx.tools as Array<Record<string, unknown>>
    const spec = tools[0].toolSpecification as Record<string, unknown>

    assert.equal(String(spec.description).length, 10000)
    assert.ok(String(spec.description).endsWith("[Description truncated to fit Kiro tool metadata limit]"))
    assert.equal(current.content, "test")
  })

  it("forwards OMP tool parameters as JSON Schema without losing detail", () => {
    // Shaped like OMP 18's bash tool: descriptions, limits, and an optional nested object.
    const payload = buildKiroPayload("model", {
      messages: [{ role: "user", content: "test" }],
      tools: [{
        name: "bash",
        description: "Run a command",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string" },
            timeout: { type: "number", description: "timeout in seconds" },
            name: { type: "string", maxLength: 48 },
            mode: { type: "string", enum: ["fg", "bg"] },
            retries: { type: "integer" },
            ready: {
              type: "object",
              properties: { log: { type: "string" }, port: { type: "number" } },
              additionalProperties: false,
            },
            env: { type: "object", properties: {}, additionalProperties: { type: "string" } },
          },
          required: ["command"],
          additionalProperties: false,
        },
      }],
    })
    const current = payload.conversationState.currentMessage.userInputMessage
    const userCtx = current.userInputMessageContext as Record<string, unknown>
    const tools = userCtx.tools as Array<Record<string, unknown>>
    const spec = tools[0].toolSpecification as Record<string, unknown>
    const schema = (spec.inputSchema as Record<string, unknown>).json

    assert.deepEqual(schema, {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout: { type: "number", description: "timeout in seconds" },
        name: { type: "string", maxLength: 48 },
        mode: { type: "string", enum: ["fg", "bg"] },
        retries: { type: "integer" },
        ready: {
          type: "object",
          properties: { log: { type: "string" }, port: { type: "number" } },
        },
        env: { type: "object", properties: {} },
      },
      required: ["command"],
    })
  })

  it("keeps names and literal values that look like stripped keywords", () => {
    const literal = { additionalProperties: false, required: [] }
    const payload = buildKiroPayload("model", {
      messages: [{ role: "user", content: "test" }],
      tools: [{
        name: "schema_tool",
        description: "Edits schemas",
        parameters: {
          type: "object",
          properties: {
            additionalProperties: { $ref: "#/$defs/additionalProperties" },
            required: { type: "array", items: { type: "string" } },
            draft: { type: "object", const: literal, default: literal },
          },
          $defs: { additionalProperties: { type: "boolean" } },
        },
      }],
    })
    const current = payload.conversationState.currentMessage.userInputMessage
    const userCtx = current.userInputMessageContext as Record<string, unknown>
    const tools = userCtx.tools as Array<Record<string, unknown>>
    const spec = tools[0].toolSpecification as Record<string, unknown>
    const schema = (spec.inputSchema as Record<string, unknown>).json as Record<string, unknown>

    assert.deepEqual(Object.keys(schema.properties as object), ["additionalProperties", "required", "draft"])
    assert.deepEqual(schema.$defs, { additionalProperties: { type: "boolean" } })
    assert.deepEqual((schema.properties as Record<string, unknown>).draft, { type: "object", const: literal, default: literal })
  })

  it("sends an empty object schema for a tool without parameters", () => {
    const payload = buildKiroPayload("model", {
      messages: [{ role: "user", content: "test" }],
      tools: [{ name: "ping", description: "Ping" }],
    })
    const current = payload.conversationState.currentMessage.userInputMessage
    const userCtx = current.userInputMessageContext as Record<string, unknown>
    const tools = userCtx.tools as Array<Record<string, unknown>>
    const spec = tools[0].toolSpecification as Record<string, unknown>

    assert.deepEqual((spec.inputSchema as Record<string, unknown>).json, { type: "object", properties: {} })
  })

  it("includes profileArn when provided", () => {
    const ctx: ContextLike = {
      systemPrompt: undefined,
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    }

    const payload = buildKiroPayload("model", ctx, "arn:aws:codewhisperer:us-east-1:123")
    assert.equal(payload.profileArn, "arn:aws:codewhisperer:us-east-1:123")
  })

  it("includes tool results in history user messages", () => {
    const ctx: ContextLike = {
      systemPrompt: undefined,
      messages: [
        { role: "user", content: "do something" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ type: "toolCall", id: "tc1", name: "read_file", arguments: { path: "/foo" } }],
        },
        {
          role: "user",
          content: "",
          toolResults: [{ toolCallId: "tc1", content: "file contents" }],
        },
      ],
      tools: [{ name: "read_file", description: "read", parameters: {} }],
    }

    const payload = buildKiroPayload("model", ctx)
    const history = payload.conversationState.history as Array<Record<string, unknown>>

    // The tool results answer the history's last turn from the current message.
    assert.equal(history.length, 2)
    const assistantEntry = history[1] as Record<string, unknown>
    const assistantMsg = assistantEntry.assistantResponseMessage as Record<string, unknown>
    assert.ok(assistantMsg.toolUses)
  })

  it("uses (empty placeholder) for empty content", () => {
    const ctx: ContextLike = {
      systemPrompt: undefined,
      messages: [{ role: "user", content: "" }],
      tools: [],
    }

    const payload = buildKiroPayload("model", ctx)
    const current = payload.conversationState.currentMessage.userInputMessage as Record<string, unknown>
    assert.equal(current.content, "(empty placeholder)")
  })
})

const FIXTURE = new Uint8Array(readFileSync(fileURLToPath(new URL("./fixtures/kiro-frames.sample.bin", import.meta.url))))

/** Rebuilds tool calls from decoded events the way core.ts does. */
function toolCalls(events: KiroEvent[]): { id: string; name: string; input: string }[] {
  const calls: { id: string; name: string; input: string }[] = []
  for (const event of events) {
    if (event.type === "tool_start") calls.push({ id: event.toolUseId, name: event.name, input: event.input })
    else if (event.type === "tool_input" && calls.length > 0) calls[calls.length - 1].input += event.input
  }
  return calls
}

function text(events: KiroEvent[]): string {
  return events.map((event) => event.type === "content" ? event.content : "").join("")
}

describe("AwsEventStreamParser", () => {
  it("parses content frames", () => {
    const parser = new AwsEventStreamParser()
    assert.deepEqual(parser.feed(content("Hello world")), [{ type: "content", content: "Hello world" }])
  })

  it("keeps a delta that repeats the previous one", () => {
    const parser = new AwsEventStreamParser()
    assert.deepEqual(parser.feed(frames(content("ha"), content("ha"))), [
      { type: "content", content: "ha" },
      { type: "content", content: "ha" },
    ])
  })

  it("parses reasoning frames and skips empty or non-string text", () => {
    const parser = new AwsEventStreamParser()
    const events = parser.feed(frames(
      reasoning("37"),
      reasoning(" * 89"),
      reasoning(""),
      frame("reasoningContentEvent", { text: 37 }),
    ))
    assert.deepEqual(events, [
      { type: "reasoning", text: "37" },
      { type: "reasoning", text: " * 89" },
    ])
  })

  it("reports redacted reasoning without its opaque content", () => {
    const parser = new AwsEventStreamParser()
    const events = parser.feed(frame("reasoningContentEvent", { redactedContent: "LktUUn5+opaque", signature: "sig" }))
    assert.deepEqual(events, [{ type: "reasoning_redacted" }])
  })

  it("assembles a tool call streamed over several frames", () => {
    const parser = new AwsEventStreamParser()
    const events = parser.feed(frames(
      frame("toolUseEvent", { name: "read", toolUseId: "tu1" }),
      frame("toolUseEvent", { input: '{"path":', name: "read", toolUseId: "tu1" }),
      frame("toolUseEvent", { input: '"/foo"}', name: "read", toolUseId: "tu1" }),
      frame("toolUseEvent", { name: "read", stop: true, toolUseId: "tu1" }),
    ))
    assert.deepEqual(events, [
      { type: "tool_start", toolUseId: "tu1", name: "read", input: "", stop: false },
      { type: "tool_input", input: '{"path":' },
      { type: "tool_input", input: '"/foo"}' },
      { type: "tool_stop", stop: true },
    ])
  })

  it("parses a single-frame tool call with object input", () => {
    const parser = new AwsEventStreamParser()
    const events = parser.feed(frame("toolUseEvent", { name: "tool", toolUseId: "t1", input: { nested: { deep: "value" } }, stop: true }))
    assert.deepEqual(events, [
      { type: "tool_start", toolUseId: "t1", name: "tool", input: '{"nested":{"deep":"value"}}', stop: true },
    ])
  })

  it("starts a new call when the tool use id changes", () => {
    const parser = new AwsEventStreamParser()
    const events = parser.feed(frames(
      frame("toolUseEvent", { name: "a", toolUseId: "t1", input: "{}" }),
      frame("toolUseEvent", { name: "b", toolUseId: "t2", input: "{}", stop: true }),
    ))
    assert.deepEqual(toolCalls(events).map((call) => call.id), ["t1", "t2"])
  })

  it("reassembles frames split across chunks", () => {
    const body = frames(content("complete "), frame("toolUseEvent", { name: "read", toolUseId: "t1", input: "{}", stop: true }))
    const parser = new AwsEventStreamParser()
    const events: KiroEvent[] = []
    for (const byte of body) events.push(...parser.feed(new Uint8Array([byte])))
    assert.deepEqual(events, new AwsEventStreamParser().feed(body))
    assert.equal(events.length, 2)
  })

  it("skips garbage and frames with a bad checksum", () => {
    const corrupt = content("corrupt")
    corrupt[corrupt.length - 6] ^= 0xff
    const parser = new AwsEventStreamParser()
    const events = parser.feed(frames(new TextEncoder().encode('garbage{"content":"leak"}'), content("hello"), corrupt, content("world")))
    assert.deepEqual(events, [
      { type: "content", content: "hello" },
      { type: "content", content: "world" },
    ])
  })

  it("routes on the event type, not the payload shape", () => {
    const parser = new AwsEventStreamParser()
    const events = parser.feed(frames(
      frame("followupPromptEvent", { content: "suggested follow-up" }),
      frame("meteringEvent", { unit: "credit", usage: 0.12 }),
      frame("codeReferenceEvent", { references: [] }),
      content('{"toolUseId":"x","input":"{braces}"}'),
    ))
    assert.deepEqual(events, [{ type: "content", content: '{"toolUseId":"x","input":"{braces}"}' }])
  })

  it("reads token usage from metadata events", () => {
    const parser = new AwsEventStreamParser()
    const events = parser.feed(frame("metadataEvent", {
      tokenUsage: {
        uncachedInputTokens: 100, outputTokens: 42, totalTokens: 152,
        cacheReadInputTokens: 7, cacheWriteInputTokens: 3, contextUsagePercentage: 12.5,
      },
    }))
    assert.deepEqual(events, [
      { type: "usage", inputTokens: 100, outputTokens: 42, cacheReadTokens: 7, cacheCreationTokens: 3, reasoningTokens: undefined },
      { type: "context_usage", percentage: 12.5 },
    ])
  })

  it("parses context usage events", () => {
    const parser = new AwsEventStreamParser()
    assert.deepEqual(parser.feed(frame("contextUsageEvent", { contextUsagePercentage: 75.5 })), [
      { type: "context_usage", percentage: 75.5 },
    ])
  })

  it("reports exception and error frames", () => {
    const parser = new AwsEventStreamParser()
    const events = parser.feed(frames(
      frame("throttlingError", { message: "Rate exceeded", reason: "INSUFFICIENT_MODEL_CAPACITY" },
        { ":message-type": "exception", ":exception-type": "ThrottlingException" }),
      frame("validationError", { message: "Input is too long" }),
      frame("", "", { ":message-type": "error", ":error-code": "InternalFailure", ":error-message": "Stream failed" }),
    ))
    assert.deepEqual(events, [
      { type: "error", errorType: "ThrottlingException", message: "Rate exceeded (INSUFFICIENT_MODEL_CAPACITY)" },
      { type: "error", errorType: "validationError", message: "Input is too long" },
      { type: "error", errorType: "InternalFailure", message: "Stream failed" },
    ])
  })

  // Captured from Kiro by Gavin Woods (github.com/GavinWoods/omp-kiro-provider).
  describe("captured Kiro response", () => {
    it("decodes the text, the streamed tool call, and the redacted reasoning", () => {
      const events = new AwsEventStreamParser().feed(FIXTURE)
      assert.equal(text(events), "<title>Print first line of file</title>test-marker-first-line")
      assert.deepEqual(toolCalls(events), [{
        id: "toolu_bdrk_016NS1XM5gC34YgrLC6sdGyw",
        name: "read",
        input: '{"path": "/tmp/kiro-capture-target.txt", "i": "Reading capture target file"}',
      }])
      assert.equal(events.filter((event) => event.type === "reasoning_redacted").length, 3)
      assert.equal(events.filter((event) => event.type === "tool_stop").length, 1)
    })

    it("decodes the same events when fed one byte at a time", () => {
      const parser = new AwsEventStreamParser()
      const events: KiroEvent[] = []
      for (const byte of FIXTURE) events.push(...parser.feed(new Uint8Array([byte])))
      assert.deepEqual(events, new AwsEventStreamParser().feed(FIXTURE))
    })
  })
})

function createTestOutput(): { output: AssistantMessageLike; events: AssistantMessageEvent[] } {
  const events: AssistantMessageEvent[] = []
  const output: AssistantMessageLike = {
    role: "assistant",
    content: [],
    api: "kiro-custom",
    provider: "kiro",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  }
  return { output, events }
}

describe("ThinkingTagParser", () => {
  it("extracts thinking block from <thinking> tags", () => {
    const { output, events } = createTestOutput()
    const parser = new ThinkingTagParser(output, (evt) => events.push(evt))

    parser.processChunk("<thinking>Let me think")
    parser.processChunk(" about this</thinking>Here is my answer")
    parser.finalize()

    assert.equal(output.content.length, 2)
    assert.equal(output.content[0].type, "thinking")
    assert.equal((output.content[0] as { thinking: string }).thinking, "Let me think about this")
    assert.equal(output.content[1].type, "text")
    assert.equal((output.content[1] as { text: string }).text, "Here is my answer")
  })

  it("handles thinking-only response", () => {
    const { output, events } = createTestOutput()
    const parser = new ThinkingTagParser(output, (evt) => events.push(evt))

    parser.processChunk("<thinking>Just thinking")
    parser.finalize()

    assert.equal(output.content.length, 1)
    assert.equal(output.content[0].type, "thinking")
    assert.equal((output.content[0] as { thinking: string }).thinking, "Just thinking")
  })

  it("handles text-only response (no thinking tags)", () => {
    const { output, events } = createTestOutput()
    const parser = new ThinkingTagParser(output, (evt) => events.push(evt))

    parser.processChunk("Just plain text here")
    parser.finalize()

    assert.equal(output.content.length, 1)
    assert.equal(output.content[0].type, "text")
    assert.equal((output.content[0] as { text: string }).text, "Just plain text here")
  })

  it("handles split tag across chunks", () => {
    const { output, events } = createTestOutput()
    const parser = new ThinkingTagParser(output, (evt) => events.push(evt))

    parser.processChunk("Some text<thin")
    parser.processChunk("king>hidden thought</thinking>more text")
    parser.finalize()

    // Thinking that arrives after text is moved ahead of it.
    assert.equal(output.content.length, 3)
    assert.equal(output.content[0].type, "thinking")
    assert.equal((output.content[0] as { thinking: string }).thinking, "hidden thought")
    assert.equal(output.content[1].type, "text")
    assert.equal((output.content[1] as { text: string }).text, "Some text")
    assert.equal(output.content[2].type, "text")
    assert.equal((output.content[2] as { text: string }).text, "more text")
  })

  it("recognizes <reasoning> tag variant", () => {
    const { output, events } = createTestOutput()
    const parser = new ThinkingTagParser(output, (evt) => events.push(evt))

    parser.processChunk("<reasoning>reasoning here</reasoning>answer")
    parser.finalize()

    assert.equal(output.content.length, 2)
    assert.equal(output.content[0].type, "thinking")
    assert.equal((output.content[0] as { thinking: string }).thinking, "reasoning here")
  })

  it("recognizes <thought> tag variant", () => {
    const { output, events } = createTestOutput()
    const parser = new ThinkingTagParser(output, (evt) => events.push(evt))

    parser.processChunk("<thought>my thoughts</thought>result")
    parser.finalize()

    assert.equal(output.content.length, 2)
    assert.equal(output.content[0].type, "thinking")
    assert.equal((output.content[0] as { thinking: string }).thinking, "my thoughts")
  })

  it("emits thinking and text events", () => {
    const { output, events } = createTestOutput()
    const parser = new ThinkingTagParser(output, (evt) => events.push(evt))

    parser.processChunk("<thinking>hello</thinking>world")
    parser.finalize()

    const types = events.map((e) => e.type)
    assert.ok(types.includes("thinking_start"))
    assert.ok(types.includes("thinking_delta"))
    assert.ok(types.includes("thinking_end"))
    assert.ok(types.includes("text_start"))
    assert.ok(types.includes("text_delta"))
  })

})

describe("parseBracketToolCalls", () => {
  it("extracts a bracket-style tool call", () => {
    const text = 'I need to use a tool. [Called read_file with args: {"path": "/tmp/test.txt"}] Done.'
    const result = parseBracketToolCalls(text)

    assert.equal(result.toolCalls.length, 1)
    assert.equal(result.toolCalls[0].name, "read_file")
    assert.deepEqual(result.toolCalls[0].arguments, { path: "/tmp/test.txt" })
    assert.ok(result.cleanedText.includes("I need to use a tool."))
    assert.ok(result.cleanedText.includes("Done."))
    assert.ok(!result.cleanedText.includes("[Called"))
  })

  it("returns empty array for text without bracket patterns", () => {
    const result = parseBracketToolCalls("Just regular text here")
    assert.equal(result.toolCalls.length, 0)
    assert.equal(result.cleanedText, "Just regular text here")
  })

  it("handles multiple bracket tool calls", () => {
    const text = '[Called func_a with args: {"x": 1}] middle [Called func_b with args: {"y": 2}]'
    const result = parseBracketToolCalls(text)

    assert.equal(result.toolCalls.length, 2)
    assert.equal(result.toolCalls[0].name, "func_a")
    assert.equal(result.toolCalls[1].name, "func_b")
  })

  it("handles nested JSON in args", () => {
    const text = '[Called tool with args: {"config": {"nested": true, "arr": [1, 2]}}]'
    const result = parseBracketToolCalls(text)

    assert.equal(result.toolCalls.length, 1)
    assert.deepEqual(result.toolCalls[0].arguments, { config: { nested: true, arr: [1, 2] } })
  })

  it("skips malformed JSON", () => {
    const text = '[Called tool with args: {broken json}]'
    const result = parseBracketToolCalls(text)

    assert.equal(result.toolCalls.length, 0)
  })

  it("leaves calls quoted as code alone", () => {
    const inline = 'The syntax is `[Called bash with args: {"command":"echo unexpected"}]`.'
    const fenced = 'Example:\n```\n[Called bash with args: {"command":"echo unexpected"}]\n```\nDone.'
    const tildes = 'Example:\n~~~\n[Called bash with args: {"command":"echo unexpected"}]\n~~~\nDone.'
    const indented = 'Example:\n\n    [Called bash with args: {"command":"echo unexpected"}]\n\nDone.'
    for (const text of [inline, fenced, tildes, indented]) {
      assert.deepEqual(parseBracketToolCalls(text), { toolCalls: [], cleanedText: text })
    }
  })

  it("generates unique toolUseId for each call", () => {
    const text = '[Called f with args: {"a": 1}] [Called f with args: {"b": 2}]'
    const result = parseBracketToolCalls(text)

    assert.equal(result.toolCalls.length, 2)
    assert.notEqual(result.toolCalls[0].toolUseId, result.toolCalls[1].toolUseId)
  })
})

describe("buildKiroPayload with history truncation", () => {
  it("truncates large history to fit context window", () => {
    const messages: Array<{ role: string; content: string }> = []
    for (let i = 0; i < 1000; i++) {
      messages.push({ role: "user", content: `User message ${i} `.repeat(100) })
      messages.push({ role: "assistant", content: `Assistant response ${i} `.repeat(100) })
    }
    messages.push({ role: "user", content: "Final message" })

    const ctx: ContextLike = {
      messages,
      tools: [],
      systemPrompt: "Test system prompt",
    }

    const payload = buildKiroPayload("test-model", ctx, undefined, 200000)

    const history = payload.conversationState.history as unknown[]
    assert.ok(history.length < 2000, `History was ${history.length}, expected < 2000`)
    assert.ok(history.length > 0)
  })

  it("preserves all history when under limit", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
      { role: "user", content: "How are you?" },
    ]

    const ctx: ContextLike = {
      messages,
      tools: [],
      systemPrompt: "Test",
    }

    const payload = buildKiroPayload("test-model", ctx, undefined, 200000)
    const history = payload.conversationState.history as unknown[]
    assert.equal(history.length, 2)
  })

  it("keeps the serialized payload below Kiro's safe request limit", () => {
    const messages: Array<{ role: string; content: string }> = []
    for (let i = 0; i < 400; i++) {
      messages.push({ role: "user", content: `User message ${i} `.repeat(100) })
      messages.push({ role: "assistant", content: `Assistant response ${i} `.repeat(100) })
    }
    messages.push({ role: "user", content: "Final message" })

    const payload = buildKiroPayload("test-model", { messages }, undefined, 1000000)
    assert.ok(Buffer.byteLength(JSON.stringify(payload), "utf8") <= 600000)
  })

  it("passes a thinking-mode system prompt through to the user message", () => {
    // core.ts adds these directives to the system prompt before building the payload.
    const ctx: ContextLike = {
      messages: [{ role: "user", content: "Think about this" }],
      tools: [],
      systemPrompt: "<thinking_mode>enabled</thinking_mode><max_thinking_length>10000</max_thinking_length>\nYou are helpful",
    }

    const payload = buildKiroPayload("test-model", ctx)

    const userMsg = (payload.conversationState.currentMessage as Record<string, unknown>).userInputMessage as Record<string, unknown>
    const content = String(userMsg.content)
    assert.ok(content.includes("<thinking_mode>enabled</thinking_mode>"))
    assert.ok(content.includes("<max_thinking_length>10000</max_thinking_length>"))
    assert.ok(content.includes("Think about this"))
  })
})

describe("resolveReasoningLevel", () => {
  it("returns false when OMP disables reasoning", () => {
    assert.equal(resolveReasoningLevel({ disableReasoning: true }), false)
    assert.equal(resolveReasoningLevel({ reasoning: "high", disableReasoning: true }), false)
  })

  it("uses the level OMP passes through, minimal to max", () => {
    assert.equal(resolveReasoningLevel({ reasoning: "high" }), "high")
    assert.equal(resolveReasoningLevel({ reasoning: "minimal" }), "minimal")
    assert.equal(resolveReasoningLevel({ reasoning: "max" }), "max")
    assert.equal(resolveReasoningLevel(), undefined)
  })
})

describe("buildKiroPayload with OMP tool calls and results", () => {
  type Entry = { userInputMessage?: Record<string, any>; assistantResponseMessage?: Record<string, any> }
  const call = (id: string, name = "read") => ({ type: "toolCall" as const, id, name, arguments: { path: `/${id}` } })
  const result = (id: string, text: string, extra: Record<string, unknown> = {}) =>
    ({ role: "toolResult" as const, toolCallId: id, toolName: "read", content: [{ type: "text" as const, text }], isError: false, ...extra })
  /** Each history entry as U[result ids] or A[tool use ids]. */
  const shape = (history: unknown) => ((history ?? []) as Entry[]).map((e) => e.userInputMessage
    ? `U${JSON.stringify((e.userInputMessage.userInputMessageContext?.toolResults ?? []).map((t: any) => t.toolUseId))}`
    : `A${JSON.stringify((e.assistantResponseMessage!.toolUses ?? []).map((t: any) => t.toolUseId))}`)
  const current = (payload: ReturnType<typeof buildKiroPayload>) => payload.conversationState.currentMessage.userInputMessage as Record<string, any>

  it("sends toolCall blocks as tool uses and toolResult messages as tool results", () => {
    const payload = buildKiroPayload("claude-sonnet-4-5", {
      systemPrompt: "SYS",
      messages: [
        { role: "user", content: [{ type: "text", text: "read foo" }] },
        { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "ok" }, call("tc1")] },
        result("tc1", "FILE CONTENTS"),
      ],
      tools: [{ name: "read", description: "read", parameters: { type: "object", properties: {} } }],
    }, undefined, 200_000)

    const history = payload.conversationState.history as Entry[]
    assert.deepEqual(shape(history), ["U[]", 'A["tc1"]'])
    assert.equal(history[1].assistantResponseMessage!.content, "ok")
    assert.deepEqual(history[1].assistantResponseMessage!.toolUses, [{ toolUseId: "tc1", name: "read", input: { path: "/tc1" } }])
    assert.deepEqual(current(payload).userInputMessageContext.toolResults,
      [{ toolUseId: "tc1", content: [{ text: "FILE CONTENTS" }], status: "success" }])
    assert.equal(current(payload).content, "(empty placeholder)")
  })

  it("answers parallel tool calls in one user turn, keeping errors, images and a message sent alongside", () => {
    const png = { type: "image" as const, data: "QUJD", mimeType: "image/png" }
    const payload = buildKiroPayload("m", {
      messages: [
        { role: "user", content: "look" },
        { role: "assistant", content: [call("a"), call("b")] },
        result("a", "A out"),
        { ...result("b", "denied", { isError: true }), content: [{ type: "text", text: "denied" }, png] },
        { role: "user", content: "also check bar" },
      ],
    }, undefined, 200_000)

    assert.deepEqual(shape(payload.conversationState.history), ["U[]", 'A["a","b"]'])
    const message = current(payload)
    assert.equal(message.content, "also check bar")
    assert.deepEqual(message.images, [{ format: "png", source: { bytes: "QUJD" } }])
    assert.deepEqual(message.userInputMessageContext.toolResults.map((t: any) => [t.toolUseId, t.status]), [["a", "success"], ["b", "error"]])
  })

  it("keeps earlier tool round trips paired in history", () => {
    const payload = buildKiroPayload("m", {
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [call("t1")] },
        result("t1", "one"),
        { role: "assistant", content: [{ type: "text", text: "next" }, call("t2")] },
        result("t2", "two"),
      ],
    }, undefined, 200_000)
    assert.deepEqual(shape(payload.conversationState.history), ["U[]", 'A["t1"]', 'U["t1"]', 'A["t2"]'])
    assert.deepEqual(current(payload).userInputMessageContext.toolResults.map((t: any) => t.toolUseId), ["t2"])
  })

  it("drops tool uses left unanswered, keeping user and assistant alternating", () => {
    const payload = buildKiroPayload("m", {
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "text", text: "calling" }, call("t1")] },
        { role: "user", content: "stop, do something else" },
      ],
    }, undefined, 200_000)
    const history = payload.conversationState.history as Entry[]
    assert.deepEqual(shape(history), ["U[]", "A[]"])
    assert.equal(history[1].assistantResponseMessage!.content, "calling")
    assert.equal(current(payload).userInputMessageContext, undefined)
  })

  it("turns results whose tool uses were trimmed away into text", () => {
    // Two of these exceed the 600 KB payload cap, so the oldest round trip is trimmed.
    const big = "x".repeat(320_000)
    const payload = buildKiroPayload("m", {
      messages: [
        { role: "user", content: big },
        { role: "assistant", content: [call("t1")] },
        result("t1", big),
        { role: "assistant", content: [call("t2")] },
        result("t2", "two"),
        { role: "assistant", content: [{ type: "text", text: "done" }] },
        { role: "user", content: "next" },
      ],
    }, undefined, 2_000_000)
    const history = payload.conversationState.history as Entry[]
    assert.deepEqual(shape(history), ["U[]", 'A["t2"]', 'U["t2"]', "A[]"])
    const text = String(history[0].userInputMessage!.content)
    assert.ok(text.startsWith("[Output of tool call t1]\nxxx"), text.slice(0, 40))
    assert.ok(text.endsWith("[End of tool output]"))
  })

  it("keeps the images of consecutive user messages", () => {
    const png = { type: "image" as const, data: "QUJD", mimeType: "image/png" }
    const payload = buildKiroPayload("m", {
      messages: [
        { role: "user", content: [{ type: "text", text: "first" }] },
        { role: "user", content: [{ type: "text", text: "see screenshot" }, png] },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        { role: "user", content: "next" },
      ],
    }, undefined, 200_000)
    const history = payload.conversationState.history as Entry[]
    assert.equal(history[0].userInputMessage!.content, "first\nsee screenshot")
    assert.deepEqual(history[0].userInputMessage!.images, [{ format: "png", source: { bytes: "QUJD" } }])
  })

  it("resolves a truncated tool name after another request with other tools", () => {
    const long = "mcp__some_server__" + "a".repeat(60)
    const first = buildKiroPayload("m", { messages: [{ role: "user", content: "hi" }], tools: [{ name: long, description: "d" }] })
    const truncated = current(first).userInputMessageContext.tools[0].toolSpecification.name as string
    assert.ok(truncated.length <= 64)
    buildKiroPayload("m", { messages: [{ role: "user", content: "hi" }], tools: [{ name: "short", description: "d" }] })
    assert.equal(resolveToolName(truncated), long)
  })
})

describe("AwsEventStreamParser tool frames", () => {
  it("ignores a frame repeated after its tool call stopped", () => {
    const parser = new AwsEventStreamParser()
    const events = parser.feed(frames(
      frame("toolUseEvent", { toolUseId: "a", name: "read", input: "{}" }),
      frame("toolUseEvent", { toolUseId: "a", stop: true }),
      frame("toolUseEvent", { toolUseId: "a", stop: true }),
      content("end"),
    ))
    assert.deepEqual(events.map((e) => e.type), ["tool_start", "tool_stop", "content"])
  })
})
