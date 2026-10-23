/**
 * Kiro credit usage for OMP's `/usage` and `omp usage`: reads `GET /Get-Usage-Limits` for the
 * account profile and maps its credit buckets onto OMP's UsageReport. The types mirror
 * @oh-my-pi/pi-ai's structurally, so the extension stays dependency-free.
 */

import {
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_TIMEOUT_MS,
  kiroBaseForRegion,
  kiroRegionFromProfileArn,
  requestManagement,
  resolveKiroProfileArn,
} from "./dynamic-models.ts"

const PROVIDER = "kiro"
const WARNING_FRACTION = 0.9

type UsageFetchParams = {
  provider: string
  credential: { type: "api_key" | "oauth"; apiKey?: string; accessToken?: string; accountId?: string }
  signal?: AbortSignal
}

type UsageWindow = { id: string; label: string; resetsAt?: number; resetLabel?: string }

type UsageLimit = {
  id: string
  label: string
  scope: { provider: string; windowId: string; accountId?: string }
  window: UsageWindow
  amount: {
    used?: number
    limit?: number
    remaining?: number
    usedFraction?: number
    remainingFraction?: number
    unit: "credits" | "unknown"
  }
  status: "ok" | "warning" | "exhausted" | "unknown"
  notes?: string[]
}

type UsageReport = {
  provider: string
  fetchedAt: number
  limits: UsageLimit[]
  notes?: string[]
  metadata: Record<string, unknown>
}

type UsageBreakdown = {
  resourceType?: string
  displayName?: string
  currentUsage?: number
  currentUsageWithPrecision?: number
  usageLimit?: number
  usageLimitWithPrecision?: number
  currentOverages?: number
  currentOveragesWithPrecision?: number
  nextDateReset?: number | string
  freeTrialInfo?: {
    currentUsage?: number
    currentUsageWithPrecision?: number
    usageLimit?: number
    usageLimitWithPrecision?: number
    freeTrialExpiry?: number | string
  }
}

type UsageLimitsResponse = {
  nextDateReset?: number | string
  usageBreakdown?: UsageBreakdown
  usageBreakdownList?: UsageBreakdown[]
  subscriptionInfo?: { subscriptionTitle?: string }
  overageConfiguration?: { overageStatus?: string }
  userInfo?: { userId?: string }
}

export type KiroUsageOptions = {
  managementBase: string
  getProfileArn: () => string | undefined
  fetchImpl?: typeof fetch
  now?: () => number
  env?: Record<string, string | undefined>
}

/** Kiro sends epoch seconds (milliseconds are accepted too) or ISO strings; OMP wants epoch milliseconds. */
function toEpochMs(value: number | string | undefined): number | undefined {
  if (value === undefined || value === null) return undefined
  const ms = typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function buildLimit(args: {
  id: string
  label: string
  used?: number
  limit?: number
  window: UsageWindow
  unit: UsageLimit["amount"]["unit"]
  notes?: string[]
  accountId?: string
}): UsageLimit {
  const limit = args.limit !== undefined && args.limit > 0 ? args.limit : undefined
  const usedFraction = limit !== undefined && args.used !== undefined ? args.used / limit : undefined
  let status: UsageLimit["status"] = "unknown"
  if (usedFraction !== undefined) {
    status = usedFraction >= 1 ? "exhausted" : usedFraction >= WARNING_FRACTION ? "warning" : "ok"
  }
  const window = { ...args.window }
  if (window.resetsAt === undefined) delete window.resetsAt
  return {
    id: args.id,
    label: args.label,
    scope: {
      provider: PROVIDER,
      windowId: window.id,
      ...(args.accountId ? { accountId: args.accountId } : {}),
    },
    window,
    amount: {
      ...(args.used !== undefined ? { used: args.used } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(limit !== undefined && args.used !== undefined ? { remaining: Math.max(0, limit - args.used) } : {}),
      ...(usedFraction !== undefined ? { usedFraction, remainingFraction: Math.max(0, 1 - usedFraction) } : {}),
      unit: args.unit,
    },
    status,
    ...(args.notes?.length ? { notes: args.notes } : {}),
  }
}

function toUsageReport(raw: UsageLimitsResponse, fetchedAt: number, credentialAccountId?: string): UsageReport {
  const buckets = Array.isArray(raw.usageBreakdownList) && raw.usageBreakdownList.length
    ? raw.usageBreakdownList
    : raw.usageBreakdown ? [raw.usageBreakdown] : []
  // An empty report would replace the last good one in OMP, so treat it as a failure.
  if (!buckets.length) throw new Error("Get-Usage-Limits returned no credit usage")
  const plan = raw.subscriptionInfo?.subscriptionTitle
  // OMP pairs a report with its credential by account id, so the credential's id wins over Kiro's user id.
  const accountId = credentialAccountId?.trim()
    || (typeof raw.userInfo?.userId === "string" ? raw.userInfo.userId.trim() : "")
    || undefined
  const limits = buckets.flatMap((bucket, index) => {
    // OMP matches limits by id, so a repeated resource type falls back to the bucket's position.
    const id = bucket.resourceType && buckets.findIndex((other) => other.resourceType === bucket.resourceType) === index
      ? bucket.resourceType
      : `usage-${index}`
    const unit = bucket.resourceType === "CREDIT" ? "credits" : "unknown"
    const overages = finite(bucket.currentOveragesWithPrecision ?? bucket.currentOverages)
    const result = [buildLimit({
      id: `kiro:${id}`,
      label: bucket.displayName || "Credits",
      used: finite(bucket.currentUsageWithPrecision ?? bucket.currentUsage),
      limit: finite(bucket.usageLimitWithPrecision ?? bucket.usageLimit),
      window: { id: "monthly", label: "Monthly", resetsAt: toEpochMs(bucket.nextDateReset ?? raw.nextDateReset) },
      unit,
      notes: overages && overages > 0 ? [`Overages: ${overages}`] : undefined,
      accountId,
    })]
    // Free-trial bonus credits expire on their own date instead of resetting monthly. A trial
    // without credits, or one that has expired, has none to report.
    const trial = bucket.freeTrialInfo
    const trialLimit = finite(trial?.usageLimitWithPrecision ?? trial?.usageLimit)
    const expiresAt = toEpochMs(trial?.freeTrialExpiry)
    if (trial && trialLimit && !(expiresAt !== undefined && expiresAt <= fetchedAt)) {
      result.push(buildLimit({
        id: `kiro:${id}:bonus`,
        label: "Bonus credits",
        used: finite(trial.currentUsageWithPrecision ?? trial.currentUsage),
        limit: trialLimit,
        window: { id: "bonus", label: "Bonus", resetsAt: expiresAt, resetLabel: "expires" },
        unit,
        accountId,
      }))
    }
    return result
  })
  return {
    provider: PROVIDER,
    fetchedAt,
    limits,
    ...(raw.overageConfiguration?.overageStatus === "ENABLED" ? { notes: ["Overages enabled"] } : {}),
    metadata: {
      source: "kiro-management",
      ...(plan ? { planType: plan } : {}),
      ...(accountId ? { accountId } : {}),
    },
  }
}

export function createKiroUsageProvider(options: KiroUsageOptions) {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? (() => Date.now())
  const accessOf = (credential: UsageFetchParams["credential"]) =>
    (credential.type === "api_key" ? credential.apiKey : credential.accessToken)?.trim()

  return {
    id: PROVIDER,
    supports: ({ provider, credential }: UsageFetchParams) => provider === PROVIDER && Boolean(accessOf(credential)),
    async fetchUsage({ credential, signal }: UsageFetchParams): Promise<UsageReport | null> {
      const apiKey = accessOf(credential)
      if (!apiKey) return null
      const profileArn = await resolveKiroProfileArn({
        apiKey,
        apiBase: options.managementBase,
        fetchImpl,
        profileArn: options.getProfileArn(),
        env: options.env,
        signal,
      })
      if (!profileArn) throw new Error("No accessible Kiro profile found for usage lookup")

      // Usage lives in the profile's region, like the model catalog.
      const url = new URL(`${kiroBaseForRegion(options.managementBase, kiroRegionFromProfileArn(profileArn))}/Get-Usage-Limits`)
      url.searchParams.set("origin", "KIRO_CLI")
      url.searchParams.set("profileArn", profileArn)
      url.searchParams.set("resourceType", "CREDIT")
      url.searchParams.set("isEmailRequired", "false")
      const { status, body, message } = await requestManagement(
        fetchImpl, url.toString(), apiKey, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_BODY_BYTES, undefined, signal,
      )
      // Throw so OMP logs the failure and keeps serving the last good report.
      if (status < 200 || status >= 300) {
        throw new Error(`Get-Usage-Limits returned HTTP ${status}${message ? `: ${message}` : ""}`)
      }
      if (typeof body !== "object" || body === null) throw new Error("Get-Usage-Limits returned no usable body")
      return toUsageReport(body as UsageLimitsResponse, now(), credential.accountId)
    },
  }
}
