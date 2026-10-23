import { isKiroApiKey, kiroAuthHeaders } from "./auth/token-type.ts"

export type OverlayModel = {
  id: string
  name: string
  reasoning: boolean
  input: ("text" | "image")[]
  contextWindow: number
  maxTokens: number
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
  thinking?: EffortThinking
}

/** OMP's thinking descriptor: the effort levels the model accepts, as Kiro's catalog lists them. */
export type EffortThinking = {
  mode: "effort"
  efforts: string[]
  defaultLevel?: string
}

export type LiveModel = {
  id: string
  name?: string
  reasoning?: boolean
  thinking?: EffortThinking
  input?: ("text" | "image")[]
  contextWindow?: number
  maxTokens?: number
}

export type FetchDynamicKiroModelsOptions = {
  apiKey?: string
  apiBase: string
  overlay: readonly OverlayModel[]
  fetchImpl?: typeof fetch
  timeoutMs?: number
  maxBodyBytes?: number
  profileArn?: string
  env?: Record<string, string | undefined>
  signal?: AbortSignal
}

export const BUILDER_ID_PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX"
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
export const DEFAULT_TIMEOUT_MS = 10_000
export const DEFAULT_MAX_BODY_BYTES = 1_048_576
const DEFAULT_CONTEXT_WINDOW = 128_000
const DEFAULT_MAX_TOKENS = 8192

/** Pages followed at most; Kiro returns a whole account's catalog in one page today. */
const MAX_CATALOG_PAGES = 20

function buildListAvailableModelsUrl(apiBase: string, profileArn: string, nextToken?: string): string {
  const url = new URL(`${apiBase.replace(/\/+$/, "")}/List-Available-Models`)
  url.searchParams.set("origin", "KIRO_CLI")
  url.searchParams.set("profileArn", profileArn)
  if (nextToken) url.searchParams.set("nextToken", nextToken)
  return url.toString()
}

export function parseLiveModels(payload: unknown): LiveModel[] | null {
  if (!isRecord(payload)) return null
  const raw = Array.isArray(payload.models)
    ? payload.models
    : Array.isArray(payload.availableModels)
      ? payload.availableModels
      : null
  if (!raw) return null

  const models: LiveModel[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const id = toOverlayModelId(nonEmptyString(entry.modelId) ?? nonEmptyString(entry.id))
    if (!id || seen.has(id)) continue
    seen.add(id)

    const live: LiveModel = { id }
    const name = nonEmptyString(entry.modelName) ?? nonEmptyString(entry.name)
    if (name) live.name = name
    const reasoning = readLiveReasoning(entry)
    if (reasoning !== undefined) live.reasoning = reasoning
    const thinking = readLiveEffort(entry)
    if (thinking) live.thinking = thinking
    if (Array.isArray(entry.supportedInputTypes)) {
      live.input = entry.supportedInputTypes.some((type) => String(type).toUpperCase() === "IMAGE") ? ["text", "image"] : ["text"]
    }
    const limits = isRecord(entry.tokenLimits) ? entry.tokenLimits : undefined
    if (limits) {
      const contextWindow = positiveInt(limits.maxInputTokens)
      const maxTokens = positiveInt(limits.maxOutputTokens)
      if (contextWindow !== undefined) live.contextWindow = contextWindow
      if (maxTokens !== undefined) live.maxTokens = maxTokens
    }
    models.push(live)
  }
  return models
}

/**
 * Builds the account's models from its live catalog: a model Kiro adds appears without a
 * models.json entry, one it retires disappears, and models.json only fills in what the
 * catalog leaves out.
 */
export function mergeLiveWithOverlay(
  overlay: readonly OverlayModel[],
  live: readonly LiveModel[],
): OverlayModel[] {
  const overlayById = new Map(overlay.map((model) => [model.id, model]))
  return live.map((item) => {
    const known = overlayById.get(item.id)
    // Kiro accepts images for every Claude model, whatever the catalog lists.
    const image = item.input?.includes("image") || known?.input.includes("image") || item.id.startsWith("claude-")
    return {
      id: item.id,
      name: friendlyLiveModelName(item, known?.name),
      reasoning: item.reasoning ?? known?.reasoning ?? false,
      input: image ? ["text", "image"] : ["text"],
      contextWindow: item.contextWindow ?? known?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: item.maxTokens ?? known?.maxTokens ?? DEFAULT_MAX_TOKENS,
      cost: { ...ZERO_COST },
      ...(item.thinking ? { thinking: item.thinking } : {}),
    }
  })
}

/**
 * Kiro often returns its technical id as the model name (`claude-opus-5.5`). A real display
 * name from the catalog wins, then the reviewed models.json name, then one derived from a known
 * Claude or GPT id pattern. Anything else keeps the name or id Kiro sent.
 */
function friendlyLiveModelName(model: LiveModel, knownName?: string): string {
  if (model.name && toOverlayModelId(model.name) !== model.id) return model.name
  if (knownName) return knownName

  const claude = /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(-1m)?$/.exec(model.id)
  if (claude) {
    const family = claude[1][0].toUpperCase() + claude[1].slice(1)
    const version = claude[2] + (claude[3] ? `.${claude[3]}` : "")
    return `Claude ${family} ${version}${claude[4] ? " (1M)" : ""}`
  }

  const gpt = /^gpt-(\d+)(?:-(\d{1,2}))?(?:-([a-z]+))?$/.exec(model.id)
  if (gpt) {
    const version = gpt[1] + (gpt[2] ? `.${gpt[2]}` : "")
    const variant = gpt[3] ? ` ${gpt[3][0].toUpperCase()}${gpt[3].slice(1)}` : ""
    return `GPT-${version}${variant}`
  }
  return model.name ?? model.id
}

/**
 * Lists the account's models. Fails rather than returning an empty list: OMP takes a
 * successful result as the whole catalog, while a failure keeps the cached one.
 */
export async function fetchDynamicKiroModels(
  options: FetchDynamicKiroModelsOptions,
): Promise<OverlayModel[]> {
  const apiKey = options.apiKey?.trim() ?? ""
  if (!apiKey) throw new Error("Kiro model discovery needs a signed-in account")

  const profileArn = await resolveKiroProfileArn(options)
  if (!profileArn) throw new Error("No accessible Kiro profile found for model discovery")
  const base = kiroBaseForRegion(options.apiBase, kiroRegionFromProfileArn(profileArn))
  // The catalog is paginated; a page cut short by nextToken must not become the whole list.
  const models: unknown[] = []
  let nextToken: string | undefined
  for (let page = 0; page < MAX_CATALOG_PAGES; page++) {
    const { status, body, message } = await requestManagement(
      options.fetchImpl ?? fetch,
      buildListAvailableModelsUrl(base, profileArn, nextToken),
      apiKey,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      undefined,
      options.signal,
    )
    if (status < 200 || status >= 300) {
      throw new Error(`List-Available-Models returned HTTP ${status}${message ? `: ${message}` : ""}`)
    }
    const pageModels = isRecord(body) ? body.models ?? body.availableModels : undefined
    if (Array.isArray(pageModels)) models.push(...pageModels)
    nextToken = isRecord(body) && typeof body.nextToken === "string" && body.nextToken ? body.nextToken : undefined
    if (!nextToken) break
  }
  if (nextToken) throw new Error(`List-Available-Models listed more than ${MAX_CATALOG_PAGES} pages`)
  const live = parseLiveModels({ models })
  if (!live?.length) throw new Error("List-Available-Models returned no usable models")
  return mergeLiveWithOverlay(options.overlay, live)
}

export async function resolveKiroProfileArn(
  options: Omit<FetchDynamicKiroModelsOptions, "overlay">,
): Promise<string | undefined> {
  const apiKey = options.apiKey?.trim() ?? ""
  if (!apiKey) return undefined
  const isApiKey = isKiroApiKey(apiKey)
  if (!isApiKey) {
    const override = nonEmptyString((options.env ?? process.env).KIRO_PROFILE_ARN)
    if (override) return override
    if (options.profileArn?.trim()) return options.profileArn.trim()
  }
  if (isApiKey) {
    const { status, body: profile, message } = await requestManagement(
      options.fetchImpl ?? fetch,
      `${kiroBaseForRegion(options.apiBase, API_KEY_REGION)}/`,
      apiKey,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      { "Content-Type": "application/x-amz-json-1.0", "X-Amz-Target": "AmazonCodeWhispererService.GetProfile" },
      options.signal,
    )
    // A rejected key is an auth failure, not an account without a profile.
    if (status < 200 || status >= 300) throw new Error(`GetProfile returned HTTP ${status}${message ? `: ${message}` : ""}`)
    return isRecord(profile) && isRecord(profile.profile) ? nonEmptyString(profile.profile.arn) : undefined
  }

  // A profile can live in a canonical region other than the caller's, so every canonical region is
  // probed before giving up. Only when all of them answer "not authorized" is the token a Builder ID
  // one; a single region answering that way may just mean the profile is elsewhere. A region that
  // fails or answers with another error does not end the probe, but its error is reported when no
  // region yields a profile, rather than guessing the Builder ID profile.
  let everyRegionNotAuthorized = true
  let probeError: unknown
  for (const base of managementBases(options.apiBase)) {
    let response: ManagementResponse
    try {
      response = await requestManagement(
        options.fetchImpl ?? fetch,
        `${base}/List-Available-Profiles`,
        apiKey,
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
        { "Content-Type": "application/json" },
        options.signal,
      )
    } catch (error) {
      if (options.signal?.aborted) throw error
      everyRegionNotAuthorized = false
      probeError = error
      continue
    }
    const { status, body: profile, message } = response
    if (status === 403 && message?.toLowerCase().includes("not authorized to access this feature")) continue
    everyRegionNotAuthorized = false
    if (status < 200 || status >= 300) {
      probeError = new Error(`List-Available-Profiles returned HTTP ${status}${message ? `: ${message}` : ""}`)
      continue
    }
    if (!isRecord(profile)) continue
    // Organization accounts may expose several profiles; the first one listed is used.
    const profiles = Array.isArray(profile.profiles) ? profile.profiles : []
    for (const entry of profiles) {
      if (!isRecord(entry)) continue
      const profileArn = nonEmptyString(entry.arn)
      if (profileArn) return profileArn
    }
  }
  // Builder ID tokens are not allowed to list profiles; they all share one public profile.
  if (everyRegionNotAuthorized) return BUILDER_ID_PROFILE_ARN
  if (probeError) throw probeError
  return undefined
}

const CANONICAL_MANAGEMENT_REGIONS = ["us-east-1", "eu-central-1"] as const
/** Kiro issues API keys against the us-east-1 control plane, so their profile is resolved there. */
const API_KEY_REGION = "us-east-1"
const KIRO_HOST = /^(https:\/\/(?:management|runtime)\.)([a-z0-9-]+)(\.kiro\.dev)$/i

/** The region a profile ARN (`arn:aws:codewhisperer:<region>:...`) belongs to. */
export function kiroRegionFromProfileArn(profileArn: string | undefined): string | undefined {
  const region = profileArn?.split(":")[3]?.toLowerCase()
  return region && /^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region) ? region : undefined
}

/**
 * A profile belongs to one region, and model discovery and inference must go to that region, so a
 * `management.<region>.kiro.dev` or `runtime.<region>.kiro.dev` base follows it. Any other base is
 * used as given.
 */
export function kiroBaseForRegion(base: string, region: string | undefined): string {
  const trimmed = base.replace(/\/+$/, "")
  const match = region ? KIRO_HOST.exec(trimmed) : null
  return match ? `${match[1]}${region}${match[3]}` : trimmed
}

// The caller's management base first, then the other canonical regions. A custom base that is not a
// `management.<region>.kiro.dev` host is used as given and never rewritten.
function managementBases(apiBase: string): string[] {
  const primary = apiBase.replace(/\/+$/, "")
  const match = /^(https:\/\/management\.)([a-z0-9-]+)(\.kiro\.dev)$/i.exec(primary)
  if (!match) return [primary]
  const others = CANONICAL_MANAGEMENT_REGIONS
    .filter((region) => region !== match[2].toLowerCase())
    .map((region) => `${match[1]}${region}${match[3]}`)
  return [primary, ...others]
}

type ManagementResponse = { status: number; body: unknown; message?: string }

/** One management API call: Kiro auth headers, a timeout, and a size-bounded JSON body. */
export async function requestManagement(
  fetchImpl: typeof fetch,
  url: string,
  apiKey: string,
  timeoutMs: number,
  maxBodyBytes: number,
  postHeaders?: Record<string, string>,
  outerSignal?: AbortSignal,
): Promise<ManagementResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onOuterAbort = () => controller.abort()
  if (outerSignal?.aborted) controller.abort()
  else outerSignal?.addEventListener("abort", onOuterAbort, { once: true })
  try {
    const response = await fetchImpl(url, {
      method: postHeaders ? "POST" : "GET",
      headers: {
        Accept: "application/json",
        ...postHeaders,
        ...kiroAuthHeaders(apiKey),
      },
      ...(postHeaders ? { body: "{}" } : {}),
      signal: controller.signal,
    })
    if (!response.ok) {
      // Error bodies are small; read them so callers can tell "not authorized" from "invalid token".
      const errorBody = await readBoundedJson(response, maxBodyBytes, controller.signal).catch(() => undefined)
      await response.body?.cancel().catch(() => {})
      return { status: response.status, body: undefined, message: isRecord(errorBody) ? nonEmptyString(errorBody.message) : undefined }
    }
    const body = await readBoundedJson(response, maxBodyBytes, controller.signal)
    await response.body?.cancel().catch(() => {})
    return { status: response.status, body }
  } finally {
    clearTimeout(timer)
    outerSignal?.removeEventListener("abort", onOuterAbort)
  }
}

async function readBoundedJson(
  response: Response,
  maxBodyBytes: number,
  signal: AbortSignal,
): Promise<unknown | undefined> {
  if (signal.aborted || !response.body) return undefined
  const declared = response.headers.get("content-length")
  if (declared) {
    const size = Number(declared)
    if (Number.isFinite(size) && size > maxBodyBytes) return undefined
  }

  const bytes = await readBoundedStream(response.body, maxBodyBytes, signal)
  if (!bytes) return undefined

  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return undefined
  }
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maxBodyBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array | undefined> {
  const reader = stream.getReader()
  const onAbort = () => {
    reader.cancel().catch(() => {})
  }
  signal.addEventListener("abort", onAbort)
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      if (signal.aborted) return undefined
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBodyBytes) {
        await reader.cancel().catch(() => {})
        return undefined
      }
      chunks.push(value)
    }
  } catch {
    return undefined
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
  return concatBytes(chunks, total)
}

function concatBytes(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function toOverlayModelId(id: string | undefined): string | undefined {
  return id?.replace(/(\d)\.(\d)(?!\d)/g, "$1-$2")
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && Number.isFinite(value) && value > 0
    ? value
    : undefined
}

/** OMP's reasoning levels, lowest first; Kiro's `none` is OMP's "off" and is not listed. */
const OMP_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"]

/**
 * Reads the effort levels Kiro accepts for a model, from `output_config.effort` (Claude) or
 * `reasoning.effort` (GPT, Kimi) in its request schema, so OMP offers exactly those levels.
 */
function readLiveEffort(item: Record<string, unknown>): EffortThinking | undefined {
  const schema = item.additionalModelRequestFieldsSchema
  const fields = isRecord(schema) && isRecord(schema.properties) ? schema.properties : undefined
  if (!fields) return undefined
  for (const field of [fields.output_config, fields.reasoning]) {
    const effort = isRecord(field) && isRecord(field.properties) ? field.properties.effort : undefined
    if (!isRecord(effort) || !Array.isArray(effort.enum)) continue
    const efforts = OMP_EFFORTS.filter((level) => (effort.enum as unknown[]).includes(level))
    if (efforts.length === 0) continue
    const thinking: EffortThinking = { mode: "effort", efforts }
    if (typeof effort.default === "string" && efforts.includes(effort.default)) thinking.defaultLevel = effort.default
    return thinking
  }
  return undefined
}

function readLiveReasoning(item: Record<string, unknown>): boolean | undefined {
  if (typeof item.reasoning === "boolean") return item.reasoning
  if (typeof item.thinking === "boolean") return item.thinking
  if (typeof item.supportsThinking === "boolean") return item.supportsThinking
  const capabilities = item.capabilities
  if (isRecord(capabilities) && typeof capabilities.thinking === "boolean") return capabilities.thinking
  // Kiro's management catalog advertises thinking through the per-model request schema:
  // a `thinking` object, or an effort setting under `reasoning` (GPT) or `output_config` (Claude).
  const schema = item.additionalModelRequestFieldsSchema
  const fields = isRecord(schema) && isRecord(schema.properties) ? schema.properties : undefined
  if (!fields) return undefined
  if (isRecord(fields.thinking) && fields.thinking.type === "object") return true
  const hasEffort = (field: unknown) => isRecord(field) && isRecord(field.properties) && isRecord(field.properties.effort)
  return hasEffort(fields.reasoning) || hasEffort(fields.output_config) ? true : undefined
}
