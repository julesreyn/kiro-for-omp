import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createKiroUsageProvider } from "../src/usage.ts"

const BASE = "https://management.us-east-1.kiro.dev"
const PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:123456789012:profile/default"

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

describe("Kiro usage provider", () => {
  it("reports monthly credits and bonus credits for an OAuth session", async () => {
    const seen: string[] = []
    const provider = createKiroUsageProvider({
      managementBase: BASE,
      getProfileArn: () => undefined,
      env: {},
      now: () => 1_000,
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        seen.push(url.pathname)
        assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer oauth-token")
        if (url.pathname === "/List-Available-Profiles") return json({ profiles: [{ arn: PROFILE_ARN }] })
        if (url.pathname === "/Get-Usage-Limits" && url.searchParams.get("profileArn") === PROFILE_ARN
          && url.searchParams.get("resourceType") === "CREDIT") {
          return json({
            subscriptionInfo: { subscriptionTitle: "KIRO PRO" },
            userInfo: { userId: "user-1" },
            usageBreakdownList: [{
              resourceType: "CREDIT",
              displayName: "Credits",
              currentUsageWithPrecision: 450,
              usageLimitWithPrecision: 1000,
              nextDateReset: 1_800_000_000,
              freeTrialInfo: { currentUsage: 100, usageLimit: 100, freeTrialExpiry: 1_790_000_000 },
            }],
          })
        }
        return json({}, 404)
      }) as typeof fetch,
    })

    const params = { provider: "kiro", credential: { type: "oauth" as const, accessToken: "oauth-token" } }
    assert.equal(provider.supports(params), true)
    const report = await provider.fetchUsage(params)

    assert.deepEqual(seen, ["/List-Available-Profiles", "/Get-Usage-Limits"])
    assert.equal(report?.metadata?.planType, "KIRO PRO")
    assert.equal(report?.limits.length, 2)
    const [monthly, bonus] = report!.limits
    assert.deepEqual(monthly.amount, {
      used: 450, limit: 1000, remaining: 550, usedFraction: 0.45, remainingFraction: 0.55, unit: "credits",
    })
    assert.equal(monthly.status, "ok")
    assert.equal(monthly.window?.resetsAt, 1_800_000_000_000)
    assert.equal(bonus.status, "exhausted")
    assert.equal(bonus.window?.resetLabel, "expires")
    // Without a credential id, the Kiro user id identifies the account.
    assert.equal(monthly.scope.accountId, "user-1")
    assert.equal(report?.metadata?.accountId, "user-1")

    // OMP pairs a report with its credential by account id, so the credential's id takes precedence.
    const paired = await provider.fetchUsage({
      provider: "kiro",
      credential: { type: "oauth", accessToken: "oauth-token", accountId: "kiro" },
    })
    assert.equal(paired?.metadata?.accountId, "kiro")
    assert.equal(paired?.limits[0].scope.accountId, "kiro")
  })

  it("uses the saved profile, reads a reset time in milliseconds, and drops an expired trial", async () => {
    const seen: string[] = []
    const provider = createKiroUsageProvider({
      managementBase: BASE,
      getProfileArn: () => PROFILE_ARN,
      now: () => 1_000_000,
      fetchImpl: (async (input: RequestInfo | URL) => {
        seen.push(new URL(String(input)).pathname)
        return json({ usageBreakdown: {
          resourceType: "CREDIT", currentUsage: 95, usageLimit: 100, nextDateReset: 1_800_000_000_000,
          freeTrialInfo: { currentUsage: 0, usageLimit: 500, freeTrialExpiry: 1 },
        } })
      }) as typeof fetch,
    })
    const report = await provider.fetchUsage({ provider: "kiro", credential: { type: "oauth", accessToken: "t" } })
    assert.deepEqual(seen, ["/Get-Usage-Limits"])
    assert.deepEqual(report?.limits.map((limit) => [limit.id, limit.status]), [["kiro:CREDIT", "warning"]])
    assert.equal(report?.limits[0].window?.resetsAt, 1_800_000_000_000)
  })

  it("sends an API key as one, to the region of its profile", async () => {
    const requests: { url: URL; headers: Record<string, string> }[] = []
    const euProfile = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/KEY"
    const provider = createKiroUsageProvider({
      managementBase: BASE,
      getProfileArn: () => PROFILE_ARN,
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        requests.push({ url, headers: init?.headers as Record<string, string> })
        if (url.pathname === "/") return json({ profile: { arn: euProfile } })
        return json({ usageBreakdownList: [{ resourceType: "CREDIT", currentUsage: 1, usageLimit: 50 }] })
      }) as typeof fetch,
    })
    const report = await provider.fetchUsage({ provider: "kiro", credential: { type: "api_key", apiKey: "ksk_test" } })
    assert.equal(report?.limits[0].amount.remaining, 49)
    const usage = requests.at(-1)!
    assert.equal(usage.url.host, "management.eu-central-1.kiro.dev")
    assert.equal(usage.url.searchParams.get("profileArn"), euProfile)
    assert.equal(usage.headers.TokenType, "API_KEY")
  })

  it("stops when OMP aborts the usage request", async () => {
    const provider = createKiroUsageProvider({
      managementBase: BASE,
      getProfileArn: () => PROFILE_ARN,
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.signal?.aborted) throw init.signal.reason
        return json({ usageBreakdownList: [{ resourceType: "CREDIT", currentUsage: 1, usageLimit: 50 }] })
      }) as typeof fetch,
    })
    await assert.rejects(provider.fetchUsage({
      provider: "kiro",
      credential: { type: "oauth", accessToken: "t" },
      signal: AbortSignal.abort(),
    }))
  })

  it("throws on an HTTP failure or an empty answer so OMP keeps the last good report", async () => {
    const answering = (response: Response) => createKiroUsageProvider({
      managementBase: BASE,
      getProfileArn: () => PROFILE_ARN,
      fetchImpl: (async () => response) as typeof fetch,
    })
    const params = { provider: "kiro", credential: { type: "oauth" as const, accessToken: "t" } }
    await assert.rejects(
      answering(json({ message: "denied" }, 403)).fetchUsage(params),
      /Get-Usage-Limits returned HTTP 403: denied/,
    )
    await assert.rejects(answering(json({ usageBreakdownList: [] })).fetchUsage(params), /no credit usage/)
  })

  it("gives a repeated resource type its own limit id and lists no trial without credits", async () => {
    const bucket = { resourceType: "CREDIT", currentUsage: 1, usageLimit: 50, freeTrialInfo: {} }
    const provider = createKiroUsageProvider({
      managementBase: BASE,
      getProfileArn: () => PROFILE_ARN,
      fetchImpl: (async () => json({ usageBreakdownList: [bucket, bucket] })) as typeof fetch,
    })
    const report = await provider.fetchUsage({ provider: "kiro", credential: { type: "oauth", accessToken: "t" } })
    assert.deepEqual(report?.limits.map((limit) => limit.id), ["kiro:CREDIT", "kiro:usage-1"])
  })

  it("rejects a credential that is not a valid header value without echoing it", async () => {
    const provider = createKiroUsageProvider({
      managementBase: BASE,
      getProfileArn: () => PROFILE_ARN,
      // Headers validates values as fetch does, so a token that reached fetch would fail here with its value quoted.
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        new Headers(init?.headers)
        return json({ usageBreakdownList: [{ resourceType: "CREDIT", currentUsage: 1, usageLimit: 50 }] })
      }) as typeof fetch,
    })
    const error = await provider.fetchUsage({
      provider: "kiro",
      credential: { type: "oauth", accessToken: "token\r\nsecret-part" },
    }).catch((caught: unknown) => caught)
    assert.ok(error instanceof Error)
    assert.match(error.message, /not valid in an HTTP header/)
    assert.doesNotMatch(error.message, /secret-part/)
  })

  it("does not support other providers or missing credentials", () => {
    const provider = createKiroUsageProvider({ managementBase: BASE, getProfileArn: () => undefined })
    assert.equal(provider.supports({ provider: "other", credential: { type: "oauth", accessToken: "t" } }), false)
    assert.equal(provider.supports({ provider: "kiro", credential: { type: "api_key", apiKey: " " } }), false)
  })
})
