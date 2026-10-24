/**
 * Shared types for the Kiro OMP provider: the parts of OMP's provider contract it uses.
 */

export type StopReason = "stop" | "length" | "toolUse"
export type ErrorReason = "error" | "aborted"
export type TerminalReason = StopReason | ErrorReason

export interface UsageCost {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning?: number
  totalTokens: number
  cost: UsageCost
}

export interface TextContent {
  type: "text"
  text: string
}

export interface ImageContent {
  type: "image"
  data: string
  mimeType: string
}

export interface ThinkingContent {
  type: "thinking"
  thinking: string
  redacted?: boolean
}

export interface ToolCallContent {
  type: "toolCall"
  id: string
  name: string
  arguments: Record<string, unknown>
}

export type AssistantContent = TextContent | ThinkingContent | ToolCallContent

export interface AssistantMessageLike {
  role: "assistant"
  content: AssistantContent[]
  api: string
  provider: string
  model: string
  usage: Usage
  stopReason: TerminalReason
  errorMessage?: string
  errorStatus?: number
  timestamp: number
  /** Request duration and time to first model output, in milliseconds, for OMP stats. */
  duration?: number
  ttft?: number
}

export interface ModelLike {
  id: string
  name: string
  reasoning: boolean
  input: ("text" | "image")[]
  contextWindow: number
  maxTokens: number
  api: string
  provider: string
  /** OMP's thinking descriptor, filled from Kiro's catalog for models with effort levels. */
  thinking?: { efforts?: readonly string[] }
}

export interface ToolResultLike {
  toolCallId: string
  content: string
  isError?: boolean
}

/**
 * A message in OMP's context. An assistant's tool calls are `toolCall` blocks in its content, and
 * each tool's output is a message of its own with role "toolResult". `toolCalls` and `toolResults`
 * beside the content are an older shape, still accepted.
 */
export interface MessageLike {
  role: "user" | "assistant" | "toolResult"
  content: string | Array<TextContent | ImageContent | ThinkingContent | ToolCallContent>
  toolCalls?: ToolCallContent[]
  toolResults?: ToolResultLike[]
  /** Set on a "toolResult" message. */
  toolCallId?: string
  toolName?: string
  isError?: boolean
}

export interface ToolLike {
  name: string
  description: string
  parameters?: unknown
}

export interface ContextLike {
  systemPrompt?: string | readonly string[]
  messages: MessageLike[]
  tools?: ToolLike[]
}

export interface ProviderResponseInfo {
  status: number
  headers: Record<string, string>
}

export interface StreamOptions {
  apiKey?: string
  signal?: AbortSignal
  headers?: Record<string, string>
  reasoning?: boolean | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
  /** Set by OMP for `--thinking off`; takes precedence over `reasoning`. */
  disableReasoning?: boolean
  onResponse?: (info: ProviderResponseInfo, model: ModelLike) => void | Promise<void>
}

export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessageLike }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessageLike }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessageLike }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessageLike }
  | { type: "thinking_start"; contentIndex: number; partial: AssistantMessageLike }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessageLike }
  | { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessageLike }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessageLike }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCallContent; partial: AssistantMessageLike }
  | { type: "done"; reason: StopReason; message: AssistantMessageLike }
  | { type: "error"; reason: ErrorReason; error: AssistantMessageLike }

export interface AssistantMessageEventStreamLike extends AsyncIterable<AssistantMessageEvent> {
  push(event: AssistantMessageEvent): void
  end(result?: AssistantMessageLike): void
  result(): Promise<AssistantMessageLike>
}

export interface CoreDependencies {
  apiBase: string
  /** Management plane base URL; derived from `apiBase` when omitted. */
  managementBase?: string
  fetchImpl: typeof fetch
  createStream: () => AssistantMessageEventStreamLike
  now: () => number
  monotonicNow?: () => number
  env: Record<string, string | undefined>
  /**
   * Ids of models whose reasoning stays server-side (`reasoningHidden` in models.json).
   * OMP drops custom model fields, so the provider passes them here.
   */
  hiddenReasoningModels?: Iterable<string>
}

export interface OAuthAuthInfo { url: string; instructions?: string }
export interface OAuthPrompt { message: string; placeholder?: string; allowEmpty?: boolean; secret?: boolean }
export interface OAuthLoginCallbacks {
  onAuth(info: OAuthAuthInfo): void | Promise<void>
  onPrompt(prompt: OAuthPrompt): Promise<string>
  onProgress?(message: string): void
}

export interface KiroAuthMeta {
  /** "social" | "idc" | "apikey" */
  method: string
  /** OIDC client registration, needed to refresh an IAM Identity Center login. */
  clientId?: string
  clientSecret?: string
  /** AWS region of the token endpoint. */
  region?: string
  /** Kiro profile sent with API requests. */
  profileArn?: string
}

/** A Kiro login as the device flow and token refresh produce it. */
export interface KiroCredentials extends KiroAuthMeta {
  access: string
  refresh: string
  expiresAt: number
}
