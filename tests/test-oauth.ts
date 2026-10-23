import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, describe, it } from "node:test"
import type { AssistantMessageEvent, AssistantMessageLike, ContextLike, CoreDependencies, ModelLike, StreamOptions } from "../src/types.ts"
import { chunked, content, eventStream, frame, frames, reasoning } from "./event-frames.ts"

// Isolate the public login/refresh API from the developer's credentials.
const home = mkdtempSync(join(tmpdir(), "omp-kiro-oauth-"))
const previousHome = process.env.HOME
const previousProfile = process.env.USERPROFILE
const previousTmpdir = process.env.TMPDIR
const previousPath = process.env.PATH
process.env.HOME = home
process.env.USERPROFILE = home
// The stream gate lives under the temp directory; keep it apart from running omp sessions.
process.env.TMPDIR = home
// A refresh may ask kiro-cli to renew its login; never reach the developer's real kiro-cli.
const noKiroCli = join(home, "no-kiro-cli")
mkdirSync(noKiroCli)
writeFileSync(join(noKiroCli, "kiro-cli"), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
process.env.PATH = `${noKiroCli}:${previousPath}`
const { getApiKey, login, refreshToken, getStoredProfileArn } = await import("../src/oauth.ts")
const { createStreamKiro } = await import("../src/core.ts")
const { buildKiroPayload } = await import("../src/converters.ts")
after(() => {
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  if (previousProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = previousProfile
  if (previousTmpdir === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = previousTmpdir
  process.env.PATH = previousPath
  rmSync(home, { recursive: true, force: true })
})

function response(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

describe("organization login", () => {
  it("authorizes in the SSO region and renews with the persisted OIDC registration", async (t) => {
    const requests: { url: string; body: Record<string, unknown> }[] = []
    const answers = ["5", "https://example.awsapps.com/start", "eu-west-1", ""]
    let browserUrl: string | undefined
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      requests.push({ url, body })
      if (url.endsWith("/client/register")) return response({ clientId: "client", clientSecret: "secret" })
      if (url.endsWith("/device_authorization")) return response({
        deviceCode: "device", userCode: "CODE", verificationUri: "https://example.com/verify",
        verificationUriComplete: "https://example.com/verify?code=CODE", interval: 0, expiresIn: 600,
      })
      if (body.grantType === "refresh_token") return response({ accessToken: "renewed", refreshToken: "rotated", expiresIn: 3600 })
      return response({ accessToken: "access", refreshToken: "refresh", expiresIn: 3600 })
    })
    const credentials = await login({
      onPrompt: async () => answers.shift() ?? "",
      onAuth: ({ url }) => { browserUrl = url },
    })
    assert.notEqual(typeof credentials, "string")
    if (typeof credentials === "string") throw new Error("Expected OAuth credentials")
    assert.equal(credentials.access, "access")
    assert.equal(credentials.refresh, "refresh")
    assert.equal(browserUrl, "https://example.com/verify?code=CODE")
    assert.equal(requests[0].url, "https://oidc.eu-west-1.amazonaws.com/client/register")
    assert.equal(requests[0].body.issuerUrl, "https://example.awsapps.com/start")
    assert.equal(requests[1].body.startUrl, "https://example.awsapps.com/start")
    const renewed = await refreshToken(credentials)
    assert.equal(renewed.access, "renewed")
    assert.equal(renewed.refresh, "rotated")
    assert.deepEqual(requests[3], {
      url: "https://oidc.eu-west-1.amazonaws.com/token",
      body: { grantType: "refresh_token", clientId: "client", clientSecret: "secret", refreshToken: "refresh" },
    })
  })

  it("uses the default region when blank and propagates denied authorization", async (t) => {
    const answers = ["5", "https://example.awsapps.com/start", "   ", ""]
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
      assert.equal(new URL(String(input)).hostname, "oidc.us-east-1.amazonaws.com")
      if (String(input).endsWith("/client/register")) return response({ clientId: "client", clientSecret: "secret" })
      if (String(input).endsWith("/device_authorization")) return response({
        deviceCode: "device", userCode: "CODE", verificationUri: "https://example.com/verify", interval: 0, expiresIn: 600,
      })
      return response({ error: "access_denied" }, 400)
    })
    await assert.rejects(login({ onPrompt: async () => answers.shift() ?? "", onAuth: () => {} }), /Authorization denied/)
  })

  it("rejects a missing organization URL", async (t) => {
    t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request") })
    for (const answers of [["5", ""]]) {
      await assert.rejects(login({
        onPrompt: async () => answers.shift() ?? "",
        onAuth: () => { throw new Error("Unexpected browser login") },
      }), /IAM Identity Center/)
    }
  })

  it("streams a discovered Opus model using the organization profile", async () => {
    const profileArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/default"
    let finish: (message: AssistantMessageLike) => void = () => { throw new Error("Result not initialized") }
    const result = new Promise<AssistantMessageLike>((resolve) => { finish = resolve })
    const events: AssistantMessageEvent[] = []
    const streamKiro = createStreamKiro({
      apiBase: "https://runtime.us-east-1.kiro.dev",
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        if (url.hostname === "management.us-east-1.kiro.dev" && url.pathname === "/List-Available-Profiles") {
          return response({ profiles: [{ arn: profileArn }] })
        }
        const payload = JSON.parse(String(init?.body)) as {
          profileArn?: string
          conversationState?: { currentMessage?: { userInputMessage?: { modelId?: string } } }
        }
        if (url.hostname !== "runtime.us-east-1.kiro.dev" || payload.profileArn !== profileArn
          || payload.conversationState?.currentMessage?.userInputMessage?.modelId !== "claude-opus-5.5") {
          return response({ message: "Invalid model or missing profile" }, 400)
        }
        return eventStream(content("OK"))
      }) as typeof fetch,
      createStream: () => ({
        push(event) {
          events.push(event)
          if (event.type === "done") finish(event.message)
          if (event.type === "error") finish(event.error)
        },
        end(message) { if (message) finish(message) },
        result: () => result,
        async *[Symbol.asyncIterator]() { yield* events },
      }),
      now: () => Date.now(),
      env: { OMP_KIRO_STREAM_GATE: "0" },
    })
    const output = await streamKiro({
      id: "claude-opus-5-5", name: "Claude Opus 5.5", api: "kiro-custom", provider: "kiro",
      reasoning: false, input: ["text"], contextWindow: 1_000_000, maxTokens: 128_000,
    }, { messages: [{ role: "user", content: "Reply OK" }] }, { apiKey: "organization-token" }).result()
    assert.equal(output.stopReason, "stop", output.errorMessage)
    assert.deepEqual(output.content, [{ type: "text", text: "OK" }])
  })
})

describe("refresh with several accounts", () => {
  it("renews each credential with its own OIDC registration, not the last login's", async (t) => {
    const tokenRequests: Record<string, unknown>[] = []
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      if (url.endsWith("/client/register")) return response({ clientId: "client-b", clientSecret: "secret-b" })
      if (url.endsWith("/device_authorization")) return response({
        deviceCode: "d", userCode: "C", verificationUri: "https://example.com/v",
        verificationUriComplete: "https://example.com/v?c=C", interval: 0, expiresIn: 600,
      })
      if (body.grantType === "refresh_token") {
        tokenRequests.push(body)
        return response({ accessToken: `renewed-${String(body.clientId)}`, refreshToken: "rotated", expiresIn: 3600 })
      }
      return response({ accessToken: "access-b", refreshToken: "refresh-b", expiresIn: 3600 })
    })
    // Account A signed in earlier, with its own registration.
    const accountA = {
      access: "access-a", refresh: "refresh-a", expires: 0,
      method: "idc", region: "us-east-1", clientId: "client-a", clientSecret: "secret-a",
    }
    // Account B signs in afterwards and overwrites the shared sidecar.
    const answers = ["4"]
    const accountB = await login({ onPrompt: async () => answers.shift() ?? "", onAuth: () => {} })
    if (typeof accountB === "string") throw new Error("Expected OAuth credentials")

    const renewedA = await refreshToken(accountA)
    const renewedB = await refreshToken(accountB)

    assert.equal(renewedA.access, "renewed-client-a")
    assert.equal(renewedB.access, "renewed-client-b")
    assert.deepEqual(tokenRequests.map((request) => request.clientId), ["client-a", "client-b"])
    // The renewed credential keeps describing its own registration.
    assert.equal(renewedA.clientId, "client-a")
  })
})

describe("single Kiro identity", () => {
  it("gives every login method and every renewal the same identity so OMP replaces the old credential", async (t) => {
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      if (url.endsWith("/client/register")) return response({ clientId: "client", clientSecret: "secret" })
      if (url.endsWith("/device_authorization")) return response({
        deviceCode: "d", userCode: "C", verificationUri: "https://example.com/v", interval: 0, expiresIn: 600,
      })
      if (body.grantType === "refresh_token") return response({ accessToken: "renewed", refreshToken: "rotated", expiresIn: 3600 })
      return response({ accessToken: "access", refreshToken: "refresh", expiresIn: 3600 })
    })
    const signIn = async (...answers: string[]) => {
      const credentials = await login({ onPrompt: async () => answers.shift() ?? "", onAuth: () => {} })
      if (typeof credentials === "string") throw new Error("Expected OAuth credentials")
      return credentials
    }
    const builderId = await signIn("4")
    const organization = await signIn("5", "https://example.awsapps.com/start", "")
    const apiKey = await signIn("2", "ksk_example")

    assert.equal(builderId.accountId, organization.accountId)
    assert.equal(organization.accountId, apiKey.accountId)
    assert.ok(builderId.accountId)
    assert.equal((await refreshToken(organization)).accountId, organization.accountId)
  })
})

describe("profile ARN after a social refresh", () => {
  it("exposes the renewed profile ARN even when the credential carries its own metadata", async (t) => {
    const oldArn = "arn:aws:codewhisperer:us-east-1:111111111111:profile/OLD"
    const newArn = "arn:aws:codewhisperer:us-east-1:111111111111:profile/NEW"
    t.mock.method(globalThis, "fetch", async () =>
      response({ accessToken: "renewed", refreshToken: "rotated", expiresIn: 3600, profileArn: newArn }))

    const renewed = await refreshToken({
      access: "old", refresh: "refresh", expires: 0,
      accountId: "kiro", method: "social", region: "us-east-1", profileArn: oldArn,
    })

    assert.equal(renewed.profileArn, newArn)
    assert.equal(getStoredProfileArn(), newArn)
  })
})

describe("credentials reused from Kiro CLI", () => {
  const cliDir = join(home, ".local", "share", "kiro-cli")
  const hasSqlite = spawnSync("sqlite3", ["--version"]).status === 0

  it("defer to the live CLI token on refresh, unlike credentials from a direct login", { skip: !hasSqlite }, async (t) => {
    mkdirSync(cliDir, { recursive: true })
    t.after(() => rmSync(cliDir, { recursive: true, force: true }))
    const token = JSON.stringify({
      access_token: "cli-access", refresh_token: "cli-refresh",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(), region: "us-east-1",
    })
    execFileSync("sqlite3", [join(cliDir, "data.sqlite3"),
      `CREATE TABLE auth_kv (key TEXT, value TEXT); CREATE TABLE state (key TEXT, value TEXT);`
      + ` INSERT INTO auth_kv VALUES ('kirocli:odic:token', '${token}');`])
    t.mock.method(globalThis, "fetch", async () =>
      response({ accessToken: "renewed", refreshToken: "rotated", expiresIn: 3600 }))

    const stored = {
      access: "stale", refresh: "stale", expires: 0,
      method: "idc", region: "us-east-1", clientId: "client", clientSecret: "secret",
    }
    const reused = await refreshToken({ ...stored, reused: true })
    assert.equal(reused.access, "cli-access")
    assert.equal(reused.reused, true)
    assert.equal((await refreshToken(stored)).access, "renewed")
  })
})

describe("credentials reused from Kiro IDE", () => {
  const ssoDir = join(home, ".aws", "sso", "cache")
  const hasSqlite = spawnSync("sqlite3", ["--version"]).status === 0

  it("defer to the live IDE token on refresh when no CLI is installed", async (t) => {
    mkdirSync(ssoDir, { recursive: true })
    t.after(() => rmSync(ssoDir, { recursive: true, force: true }))
    writeFileSync(join(ssoDir, "kiro-auth-token.json"), JSON.stringify({
      accessToken: "ide-access", refreshToken: "ide-refresh",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(), region: "us-east-1",
    }))
    t.mock.method(globalThis, "fetch", async () =>
      response({ accessToken: "renewed", refreshToken: "rotated", expiresIn: 3600 }))

    const stored = {
      access: "stale", refresh: "stale", expires: 0,
      method: "social", region: "us-east-1",
    }
    const reused = await refreshToken({ ...stored, reused: true })
    assert.equal(reused.access, "ide-access")
    assert.equal(reused.reused, true)
    assert.equal((await refreshToken(stored)).access, "renewed")
  })

  it("refresh with the credential's own metadata when the live IDE token has expired", async (t) => {
    mkdirSync(ssoDir, { recursive: true })
    t.after(() => rmSync(ssoDir, { recursive: true, force: true }))
    writeFileSync(join(ssoDir, "kiro-auth-token.json"), JSON.stringify({
      accessToken: "ide-access", refreshToken: "ide-refresh",
      expiresAt: new Date(Date.now() - 3_600_000).toISOString(), region: "us-east-1",
    }))
    t.mock.method(globalThis, "fetch", async () =>
      response({ accessToken: "renewed", refreshToken: "rotated", expiresIn: 3600 }))

    const reused = await refreshToken({
      access: "stale", refresh: "stale", expires: 0,
      method: "social", region: "us-east-1", reused: true,
    })
    assert.equal(reused.access, "renewed")
    assert.equal(reused.reused, true)
  })

  it("defer to the live IDE token when an installed kiro-cli holds an expired one", { skip: !hasSqlite }, async (t) => {
    const cliDir = join(home, ".local", "share", "kiro-cli")
    mkdirSync(cliDir, { recursive: true })
    mkdirSync(ssoDir, { recursive: true })
    t.after(() => {
      rmSync(cliDir, { recursive: true, force: true })
      rmSync(ssoDir, { recursive: true, force: true })
    })
    const expiredCliToken = JSON.stringify({
      access_token: "cli-access", refresh_token: "cli-refresh",
      expires_at: new Date(Date.now() - 3_600_000).toISOString(), region: "us-east-1",
    })
    execFileSync("sqlite3", [join(cliDir, "data.sqlite3"),
      `CREATE TABLE auth_kv (key TEXT, value TEXT); CREATE TABLE state (key TEXT, value TEXT);`
      + ` INSERT INTO auth_kv VALUES ('kirocli:odic:token', '${expiredCliToken}');`])
    writeFileSync(join(ssoDir, "kiro-auth-token.json"), JSON.stringify({
      accessToken: "ide-access", refreshToken: "ide-refresh",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(), region: "us-east-1",
    }))

    const reused = await refreshToken({
      access: "stale", refresh: "stale", expires: 0,
      method: "social", region: "us-east-1", reused: true,
    })
    assert.equal(reused.access, "ide-access")
  })
})

describe("API key login", () => {
  it("returns a credential that carries its own refresh method", async () => {
    const answers = ["2", "ksk_example"]
    const credentials = await login({ onPrompt: async () => answers.shift() ?? "", onAuth: () => {} })
    if (typeof credentials === "string") throw new Error("Expected OAuth credentials")
    assert.equal(credentials.method, "apikey")
    assert.equal((await refreshToken(credentials)).access, "ksk_example")
  })
})

describe("cancelling while the profile is resolved", () => {
  it("reports an abort instead of a missing profile", async () => {
    const controller = new AbortController()
    let finish: (message: AssistantMessageLike) => void = () => { throw new Error("Result not initialized") }
    const result = new Promise<AssistantMessageLike>((resolve) => { finish = resolve })
    const events: AssistantMessageEvent[] = []
    const streamKiro = createStreamKiro({
      apiBase: "https://runtime.us-east-1.kiro.dev",
      fetchImpl: (async () => {
        controller.abort()
        return response({ profiles: [] })
      }) as typeof fetch,
      createStream: () => ({
        push(event) {
          events.push(event)
          if (event.type === "done") finish(event.message)
          if (event.type === "error") finish(event.error)
        },
        end(message) { if (message) finish(message) },
        result: () => result,
        async *[Symbol.asyncIterator]() { yield* events },
      }),
      now: () => Date.now(),
      env: { OMP_KIRO_STREAM_GATE: "0" },
    })
    const output = await streamKiro({
      id: "claude-opus-5-5", name: "Claude Opus 5.5", api: "kiro-custom", provider: "kiro",
      reasoning: false, input: ["text"], contextWindow: 1_000_000, maxTokens: 128_000,
    }, { messages: [{ role: "user", content: "Reply OK" }] }, { apiKey: "organization-token", signal: controller.signal }).result()
    assert.equal(output.stopReason, "aborted", output.errorMessage)
    assert.doesNotMatch(output.errorMessage ?? "", /No accessible Kiro profile/)
  })
})

// Server-side reasoning, as models.json marks it and index.ts passes it on.
const HIDDEN_REASONING_MODEL: Partial<ModelLike> = { id: "claude-opus-4-7", reasoning: true }
const HIDDEN_REASONING: Partial<CoreDependencies> = { hiddenReasoningModels: ["claude-opus-4-7"] }

/**
 * Returns a function that streams one "Reply OK" turn through `fetchImpl` per call,
 * recording every streamed event in `events`.
 */
function kiroTurns(
  fetchImpl: typeof fetch,
  model: Partial<ModelLike> = {},
  deps: Partial<CoreDependencies> = {},
  events: AssistantMessageEvent[] = [],
): (apiKey: string, options?: StreamOptions, context?: ContextLike) => Promise<AssistantMessageLike> {
  const streamKiro = createStreamKiro({
    apiBase: "https://runtime.us-east-1.kiro.dev",
    fetchImpl,
    createStream: () => {
      let finish: (message: AssistantMessageLike) => void = () => { throw new Error("Result not initialized") }
      const result = new Promise<AssistantMessageLike>((resolve) => { finish = resolve })
      return {
        push(event) {
          events.push(event)
          if (event.type === "done") finish(event.message)
          if (event.type === "error") finish(event.error)
        },
        end(message) { if (message) finish(message) },
        result: () => result,
        async *[Symbol.asyncIterator]() { yield* events },
      }
    },
    now: () => Date.now(),
    env: { OMP_KIRO_STREAM_GATE: "0" },
    ...deps,
  })
  return (apiKey, options = {}, context = { messages: [{ role: "user", content: "Reply OK" }] }) => streamKiro({
    id: "claude-opus-5-5", name: "Claude Opus 5.5", api: "kiro-custom", provider: "kiro",
    reasoning: false, input: ["text"], contextWindow: 1_000_000, maxTokens: 128_000, ...model,
  }, context, { ...options, apiKey }).result()
}

/** Streams one "Reply OK" turn through `fetchImpl` and returns the final message. */
function streamOnce(
  fetchImpl: typeof fetch,
  apiKey: string,
  options: StreamOptions = {},
): Promise<AssistantMessageLike> {
  return kiroTurns(fetchImpl)(apiKey, options)
}

/** Answers inference with `bodies` in turn; counts the calls and keeps the request bodies. */
function kiro(bodies: (Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>)[]) {
  const calls = { inference: 0 }
  const requests: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(String(input)).pathname === "/List-Available-Profiles") {
      return response({ profiles: [{ arn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/default" }] })
    }
    requests.push(String(init?.body))
    return new Response(bodies[calls.inference++])
  }) as typeof fetch
  return { calls, requests, fetchImpl }
}

describe("profile region", () => {
  it("sends inference to the region that owns the profile", async () => {
    const euArn = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/EUPROFILE"
    const inferenceHosts: string[] = []
    const output = await streamOnce((async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname === "/List-Available-Profiles") {
        return url.hostname === "management.eu-central-1.kiro.dev"
          ? response({ profiles: [{ arn: euArn }] })
          : response({ message: "User is not authorized to access this feature." }, 403)
      }
      inferenceHosts.push(url.hostname)
      return eventStream(content("OK"))
    }) as typeof fetch, "eu-organization-token")
    assert.equal(output.stopReason, "stop", output.errorMessage)
    assert.deepEqual(inferenceHosts, ["runtime.eu-central-1.kiro.dev"])
  })

  it("uses the profile saved at login without listing profiles", async (t) => {
    const metaPath = join(home, ".omp", "agent", "kiro-auth-meta.json")
    const saved = existsSync(metaPath) ? readFileSync(metaPath, "utf-8") : undefined
    t.after(() => saved === undefined ? rmSync(metaPath, { force: true }) : writeFileSync(metaPath, saved))
    const storedArn = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/STORED"
    mkdirSync(dirname(metaPath), { recursive: true })
    writeFileSync(metaPath, JSON.stringify({ method: "social", profileArn: storedArn }))
    const inference: { host: string; profileArn?: string }[] = []
    const output = await streamOnce((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === "/List-Available-Profiles") return response({ message: "Unexpected profile lookup" }, 500)
      inference.push({ host: url.hostname, profileArn: JSON.parse(String(init?.body)).profileArn })
      return eventStream(content("OK"))
    }) as typeof fetch, "stored-profile-token")
    assert.equal(output.stopReason, "stop", output.errorMessage)
    assert.deepEqual(inference, [{ host: "runtime.eu-central-1.kiro.dev", profileArn: storedArn }])
  })
})

describe("credential type header", () => {
  it("declares an API key on inference and sends the key's own profile", async () => {
    const keyArn = "arn:aws:codewhisperer:us-east-1:987654321098:profile/api-key"
    let inference: { tokenType: string | null; profileArn?: string } | undefined
    const output = await streamOnce((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const headers = new Headers(init?.headers)
      if (url.hostname === "management.us-east-1.kiro.dev") {
        return headers.get("TokenType") === "API_KEY"
          ? response({ profile: { arn: keyArn } })
          : response({ message: "The bearer token included in the request is invalid." }, 403)
      }
      inference = { tokenType: headers.get("TokenType"), profileArn: JSON.parse(String(init?.body)).profileArn }
      return eventStream(content("OK"))
    }) as typeof fetch, "ksk_example_api_key")
    assert.equal(output.stopReason, "stop", output.errorMessage)
    assert.deepEqual(inference, { tokenType: "API_KEY", profileArn: keyArn })
  })

  it("recognizes an API key that arrives with surrounding whitespace", async () => {
    let inference: { authorization: string | null; tokenType: string | null } | undefined
    const output = await streamOnce((async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      if (new URL(String(input)).hostname === "management.us-east-1.kiro.dev") {
        return response({ profile: { arn: "arn:aws:codewhisperer:us-east-1:987654321098:profile/api-key" } })
      }
      inference = { authorization: headers.get("Authorization"), tokenType: headers.get("TokenType") }
      return eventStream(content("OK"))
    }) as typeof fetch, " ksk_example_api_key\n")
    assert.equal(output.stopReason, "stop", output.errorMessage)
    assert.deepEqual(inference, { authorization: "Bearer ksk_example_api_key", tokenType: "API_KEY" })
  })

  it("never lets a request header declare an OAuth token as an API key", async () => {
    let tokenTypes: Array<string | null> = []
    const output = await streamOnce((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === "/List-Available-Profiles") {
        return response({ profiles: [{ arn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/default" }] })
      }
      const headers = new Headers(init?.headers)
      tokenTypes = [headers.get("TokenType")]
      return eventStream(content("OK"))
    }) as typeof fetch, "header-oauth-token", { headers: { tokentype: "API_KEY", Authorization: "Bearer other" } })
    assert.equal(output.stopReason, "stop", output.errorMessage)
    assert.deepEqual(tokenTypes, [null])
  })
})

describe("reasoning stream", () => {
  const profileArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/default"
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
  }

  it("retries an empty turn", async () => {
    const { calls, fetchImpl } = kiro([frames(), content("OK")])
    const output = await streamOnce(fetchImpl, "empty-turn-token", { reasoning: "high" })
    assert.equal(output.stopReason, "stop", output.errorMessage)
    assert.equal(calls.inference, 2)
  })

  it("accepts a tool call that never sends its closing frame as the answer", async () => {
    const toolCall = frame("toolUseEvent", { toolUseId: "tool-1", name: "read", input: '{"path":"a"}' })
    const { calls, fetchImpl } = kiro([toolCall, content("OK")])
    const output = await streamOnce(fetchImpl, "unclosed-tool-token")
    assert.equal(output.stopReason, "toolUse", output.errorMessage)
    assert.equal(calls.inference, 1)
    assert.deepEqual(output.content.map((block) => block.type), ["toolCall"])
  })

  it("reports a turn that only reasoned instead of replaying the shown reasoning", async () => {
    const { calls, fetchImpl } = kiro([reasoning("Thinking"), frames(reasoning("Thinking"), content("OK"))])
    const output = await streamOnce(fetchImpl, "reasoning-only-token", { reasoning: "high" })
    assert.equal(output.stopReason, "error")
    assert.match(output.errorMessage ?? "", /after reasoning, without an answer/)
    assert.equal(calls.inference, 1)
  })

  it("keeps the hidden-reasoning breadcrumb ahead of the answer across a retry", async () => {
    const { calls, fetchImpl } = kiro([frames(), content("OK")])
    const output = await kiroTurns(fetchImpl, HIDDEN_REASONING_MODEL, HIDDEN_REASONING)(
      "hidden-reasoning-token", { reasoning: "high" })
    assert.equal(output.stopReason, "stop", output.errorMessage)
    assert.equal(calls.inference, 2)
    assert.deepEqual(output.content.map((block) => block.type), ["thinking", "text"])
  })

  it("shows reasoning a hidden-reasoning model streams in place of its breadcrumb", async () => {
    const { fetchImpl } = kiro([frames(reasoning("visible"), content("OK"))])
    const output = await kiroTurns(fetchImpl, HIDDEN_REASONING_MODEL, HIDDEN_REASONING)(
      "hidden-reasoning-text-token", { reasoning: "high" })
    assert.equal(output.stopReason, "stop", output.errorMessage)
    assert.deepEqual(output.content.map((block) => block.type), ["thinking", "text"])
    assert.deepEqual(output.content[0], { type: "thinking", thinking: "visible" })
  })

  it("drops the hidden-reasoning placeholder once readable reasoning arrives", async () => {
    // The placeholder appears after two seconds of silence.
    const late = new ReadableStream<Uint8Array>({
      async start(controller) {
        await new Promise((resolve) => setTimeout(resolve, 2_200))
        controller.enqueue(frames(reasoning("visible"), content("OK")))
        controller.close()
      },
    })
    const { fetchImpl } = kiro([late])
    const output = await kiroTurns(fetchImpl, HIDDEN_REASONING_MODEL, HIDDEN_REASONING)(
      "late-reasoning-token", { reasoning: "high" })
    assert.equal(output.stopReason, "stop", output.errorMessage)
    assert.deepEqual(output.content.map((block) => block.type), ["thinking", "text"])
    assert.deepEqual(output.content[0], { type: "thinking", thinking: "visible" })
  })

  // OMP drops custom model fields such as `reasoningHidden`, so the provider passes the ids itself.
  it("treats a model the provider lists as hidden-reasoning as one", async () => {
    const { requests, fetchImpl } = kiro([content("OK")])
    const output = await kiroTurns(fetchImpl, { id: "claude-opus-4-7", reasoning: true }, {
      hiddenReasoningModels: ["claude-opus-4-7"],
    })("listed-hidden-token", { reasoning: "high" })
    assert.equal(output.stopReason, "stop", output.errorMessage)
    assert.deepEqual(output.content.map((block) => block.type), ["thinking", "text"])
    assert.doesNotMatch(requests[0], /thinking_mode/)
  })

  // A model can redact a single response (Claude does for safety), and `auto` routes
  // each turn to a different model, so redaction says nothing about the next turn.
  it("hides redacted reasoning without treating the model as hidden-reasoning", async () => {
    const { requests, fetchImpl } = kiro([
      frames(content("OK"), frame("reasoningContentEvent", { redactedContent: "LktUUn5+opaque" })),
      frames(content("<thinking>plan</thinking>answer")),
    ])
    const turn = kiroTurns(fetchImpl, { id: "auto", reasoning: true })
    const first = await turn("redacted-reasoning-token", { reasoning: "high" })
    assert.equal(first.stopReason, "stop", first.errorMessage)
    assert.deepEqual(first.content.map((block) => block.type), ["text"])
    assert.ok(!JSON.stringify(first.content).includes("LktUUn5"))

    const second = await turn("redacted-reasoning-token", { reasoning: "high" })
    assert.match(requests[1], /thinking_mode/)
    assert.deepEqual(second.content, [
      { type: "thinking", thinking: "plan" },
      { type: "text", text: "answer" },
    ])
  })

  it("asks for no reasoning when thinking is off", async () => {
    const { requests, fetchImpl } = kiro([content("OK")])
    const output = await kiroTurns(fetchImpl, { reasoning: true })("thinking-off-token", { disableReasoning: true })
    assert.equal(output.stopReason, "stop", output.errorMessage)
    assert.doesNotMatch(requests[0], /thinking_mode/)
  })

  it("counts reasoning toward output tokens when Kiro reports no usage", async () => {
    const { fetchImpl } = kiro([frames(reasoning("x".repeat(400)), content("OK"))])
    const output = await streamOnce(fetchImpl, "reasoning-usage-token", { reasoning: "high" })
    assert.equal(output.stopReason, "stop", output.errorMessage)
    assert.equal(output.usage.output, 100)
  })

  it("treats reasoning as stream activity before the first answer", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
    let send: (chunk: Uint8Array) => void = () => { throw new Error("Stream not opened") }
    let close = () => {}
    const result = streamOnce((async (input: RequestInfo | URL) => {
      if (new URL(String(input)).pathname === "/List-Available-Profiles") {
        return response({ profiles: [{ arn: profileArn }] })
      }
      return new Response(new ReadableStream({
        start(controller) {
          send = (chunk) => controller.enqueue(chunk)
          close = () => controller.close()
        },
      }))
    }) as typeof fetch, "long-reasoning-token", { reasoning: "high" })

    // Reason for 200s, past the 180s first-token timeout, before answering.
    await settle()
    send(reasoning("Weighing"))
    await settle()
    t.mock.timers.tick(100_000)
    send(reasoning(" options"))
    await settle()
    t.mock.timers.tick(100_000)
    await settle()
    send(content("OK"))
    close()

    const output = await result
    assert.equal(output.stopReason, "stop", output.errorMessage)
    assert.deepEqual(output.content.map((block) => block.type), ["thinking", "text"])
  })

  it("asks for the largest thinking budget at max effort", async () => {
    let body = ""
    const output = await streamOnce((async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname === "/List-Available-Profiles") {
        return response({ profiles: [{ arn: profileArn }] })
      }
      body = String(init?.body)
      return eventStream(content("OK"))
    }) as typeof fetch, "max-effort-token", { reasoning: "max" })
    assert.equal(output.stopReason, "stop", output.errorMessage)
    assert.match(body, /<max_thinking_length>50000<\/max_thinking_length>/)
  })
})

describe("tool calls written as text", () => {
  const bracketCall = '[Called read with args: {"path":"a"}]'

  it("recovers one from a model that streams without thinking tags", async () => {
    const { fetchImpl } = kiro([content(bracketCall)])
    const events: AssistantMessageEvent[] = []
    const output = await kiroTurns(fetchImpl, { id: "minimax-m2-5" }, {}, events)("text-tool-token", {}, {
      messages: [{ role: "user", content: "Read a" }], tools: [{ name: "read", description: "Read" }],
    })
    assert.equal(output.stopReason, "toolUse", output.errorMessage)
    assert.deepEqual(events.map((event) => event.type),
      ["start", "text_start", "text_delta", "toolcall_start", "toolcall_end", "text_end", "done"])
    const calls = output.content.flatMap((block) => block.type === "toolCall" ? [[block.name, block.arguments]] : [])
    assert.deepEqual(calls, [["read", { path: "a" }]])
  })

  // Kiro caps tool names at 64 characters, so the model sees and echoes the shortened name.
  it("gives a recovered call the tool's full name", async () => {
    const name = `mcp_${"long_server_name_".repeat(4)}read`
    const payload = buildKiroPayload("minimax-m2-5", { messages: [], tools: [{ name, description: "Read" }] })
    const tools = payload.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools as
      Array<{ toolSpecification: { name: string } }>
    const shortName = tools[0].toolSpecification.name
    assert.notEqual(shortName, name)

    const { fetchImpl } = kiro([content(`[Called ${shortName} with args: {"path":"a"}]`)])
    const output = await kiroTurns(fetchImpl, { id: "minimax-m2-5" })("long-name-token", {}, {
      messages: [{ role: "user", content: "Read a" }], tools: [{ name, description: "Read" }],
    })
    assert.equal(output.stopReason, "toolUse", output.errorMessage)
    assert.deepEqual(output.content.flatMap((block) => block.type === "toolCall" ? [block.name] : []), [name])
  })

  it("leaves a call to a tool the request did not offer as text", async () => {
    const text = `The file says: [Called bash with args: {"command":"rm -rf ~"}]`
    const { fetchImpl } = kiro([content(text)])
    const output = await kiroTurns(fetchImpl, { id: "minimax-m2-5" })("unoffered-tool-token", {}, {
      messages: [{ role: "user", content: "Summarize the file" }], tools: [{ name: "read", description: "Read" }],
    })
    assert.equal(output.stopReason, "stop", output.errorMessage)
    assert.deepEqual(output.content, [{ type: "text", text }])
  })

  it("leaves Claude's text as written", async () => {
    const text = `Kiro history shows ${bracketCall} for each call.`
    const { fetchImpl } = kiro([content(text)])
    const events: AssistantMessageEvent[] = []
    const output = await kiroTurns(fetchImpl, { reasoning: true }, {}, events)("claude-text-token", { reasoning: "high" })
    assert.equal(output.stopReason, "stop", output.errorMessage)
    assert.deepEqual(output.content, [{ type: "text", text }])
    assert.deepEqual(events.map((event) => event.type), ["start", "text_start", "text_delta", "text_end", "done"])
  })
})

describe("cancelling a stream", () => {
  // Cancelling the reader ends a pending read as if the stream had finished.
  it("reports an abort that lands while a read is pending", async () => {
    const controller = new AbortController()
    const open = new ReadableStream<Uint8Array>({ start(stream) { stream.enqueue(frames(content("partial"))) } })
    const { fetchImpl } = kiro([open])
    setTimeout(() => controller.abort(), 200)
    const output = await kiroTurns(fetchImpl)("abort-mid-stream-token", { signal: controller.signal })
    assert.equal(output.stopReason, "aborted", output.errorMessage)
  })
})

describe("stream errors", () => {
  const capacity = frame("throttlingError", { message: "I am experiencing high traffic", reason: "INSUFFICIENT_MODEL_CAPACITY" },
    { ":message-type": "exception", ":exception-type": "ThrottlingException" })

  it("keeps the hidden-reasoning breadcrumb when a retry discards the reasoning that took it over", async () => {
    const { calls, fetchImpl } = kiro([frames(reasoning("draft"), capacity), content("OK")])
    const output = await kiroTurns(fetchImpl, HIDDEN_REASONING_MODEL, HIDDEN_REASONING)(
      "breadcrumb-retry-token", { reasoning: "high" })
    assert.equal(output.stopReason, "stop", output.errorMessage)
    assert.equal(calls.inference, 2)
    assert.deepEqual(output.content, [
      { type: "thinking", thinking: "", redacted: true },
      { type: "text", text: "OK" },
    ])
  })

  it("keeps the hidden-reasoning breadcrumb when a retry discards the answer that closed it", async () => {
    const { calls, fetchImpl } = kiro([frames(content("Discarded"), capacity), content("OK")])
    const output = await kiroTurns(fetchImpl, HIDDEN_REASONING_MODEL, HIDDEN_REASONING)(
      "breadcrumb-close-retry-token", { reasoning: "high" })
    assert.equal(output.stopReason, "stop", output.errorMessage)
    assert.equal(calls.inference, 2)
    assert.deepEqual(output.content, [
      { type: "thinking", thinking: "", redacted: true },
      { type: "text", text: "OK" },
    ])
  })

  it("shows the answer that arrived with a failure before reporting it", async () => {
    const invalid = frame("validationError", { message: "Input is too long" },
      { ":message-type": "exception", ":exception-type": "ValidationException" })
    const { fetchImpl } = kiro([frames(content("Partial"), invalid)])
    const events: AssistantMessageEvent[] = []
    const output = await kiroTurns(fetchImpl, HIDDEN_REASONING_MODEL, HIDDEN_REASONING, events)(
      "breadcrumb-failure-token", { reasoning: "high" })
    assert.equal(output.stopReason, "error")
    assert.deepEqual(events.map((event) => event.type),
      ["start", "thinking_start", "thinking_end", "text_start", "text_delta", "error"])
    assert.deepEqual(output.content, [
      { type: "thinking", thinking: "", redacted: true },
      { type: "text", text: "Partial" },
    ])
  })

  it("retries a turn Kiro had no capacity for", async () => {
    const { calls, fetchImpl } = kiro([capacity, content("OK")])
    const output = await streamOnce(fetchImpl, "capacity-token")
    assert.equal(output.stopReason, "stop", output.errorMessage)
    assert.equal(calls.inference, 2)
  })

  it("retries a stream that fails on Kiro's side before anything is shown", async () => {
    const unavailable = frame("serviceUnavailableError", { message: "Service is unavailable" },
      { ":message-type": "exception", ":exception-type": "ServiceUnavailableException" })
    const { calls, fetchImpl } = kiro([frames(content("Discarded"), unavailable), content("OK")])
    const output = await streamOnce(fetchImpl, "unavailable-token")
    assert.equal(output.stopReason, "stop", output.errorMessage)
    assert.equal(calls.inference, 2)
    assert.equal(output.content[0].type === "text" && output.content[0].text, "OK")
  })

  it("retries a capacity error that arrives with the first answer text", async () => {
    const { calls, fetchImpl } = kiro([frames(content("Discarded"), capacity), content("OK")])
    const output = await streamOnce(fetchImpl, "capacity-same-chunk-token")
    assert.equal(output.stopReason, "stop", output.errorMessage)
    assert.equal(calls.inference, 2)
    assert.equal(output.content[0].type === "text" && output.content[0].text, "OK")
  })

  it("does not retry a capacity error once the answer is on screen", async () => {
    const { calls, fetchImpl } = kiro([chunked(content("Partial answer"), capacity), content("OK")])
    const output = await streamOnce(fetchImpl, "capacity-late-token")
    assert.equal(output.stopReason, "error")
    assert.match(output.errorMessage ?? "", /INSUFFICIENT_MODEL_CAPACITY/)
    assert.equal(calls.inference, 1)
  })

  it("keeps an answer that merely mentions an error code", async () => {
    const text = "INSUFFICIENT_MODEL_CAPACITY and TEMPORARILY_SUSPENDED are Kiro error codes."
    const { calls, fetchImpl } = kiro([content(text)])
    const output = await streamOnce(fetchImpl, "error-code-text-token")
    assert.equal(output.stopReason, "stop", output.errorMessage)
    assert.equal(calls.inference, 1)
    assert.equal(output.content[0].type === "text" && output.content[0].text, text)
  })

  it("reports a rejected request without retrying it", async () => {
    const invalid = frame("validationError", { message: "Input is too long", reason: "CONTENT_LENGTH_EXCEEDS_THRESHOLD" },
      { ":message-type": "exception", ":exception-type": "ValidationException" })
    const { calls, fetchImpl } = kiro([invalid, content("OK")])
    const output = await streamOnce(fetchImpl, "validation-token")
    assert.equal(output.stopReason, "error")
    assert.match(output.errorMessage ?? "", /ValidationException.*Input is too long \(CONTENT_LENGTH_EXCEEDS_THRESHOLD\)/)
    assert.equal(calls.inference, 1)
  })

  it("reports a suspension sent in the stream", async () => {
    const suspended = frame("error", { message: "Account suspended", reason: "TEMPORARILY_SUSPENDED" },
      { ":message-type": "exception", ":exception-type": "AccessDeniedException" })
    const { calls, fetchImpl } = kiro([suspended, content("OK")])
    const output = await streamOnce(fetchImpl, "suspended-stream-token")
    assert.equal(output.stopReason, "error")
    assert.match(output.errorMessage ?? "", /suspended/)
    assert.equal(calls.inference, 1)
  })
})

describe("cached profile", () => {
  const profileArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/default"
  /** Streams two turns, the first rejected with a 403 `firstBody`, and counts profile lookups. */
  const twoTurns = async (firstBody: unknown) => {
    let lookups = 0
    let inferences = 0
    const turn = kiroTurns((async (input: RequestInfo | URL) => {
      if (new URL(String(input)).pathname === "/List-Available-Profiles") {
        lookups += 1
        return response({ profiles: [{ arn: profileArn }] })
      }
      inferences += 1
      return inferences === 1 ? response(firstBody, 403) : eventStream(content("OK"))
    }) as typeof fetch)
    assert.equal((await turn("organization-token")).stopReason, "error")
    assert.equal((await turn("organization-token")).stopReason, "stop")
    return lookups
  }

  it("is looked up again after Kiro rejects a request made with it", async () => {
    assert.equal(await twoTurns({ message: "Profile not found" }), 2)
  })

  it("survives a suspension, which says nothing about the profile", async () => {
    assert.equal(await twoTurns({ reason: "TEMPORARILY_SUSPENDED" }), 1)
  })

  it("forgets the oldest profiles once many tokens have been used", async () => {
    let lookups = 0
    const turn = kiroTurns((async (input: RequestInfo | URL) => {
      if (new URL(String(input)).pathname === "/List-Available-Profiles") {
        lookups += 1
        return response({ profiles: [{ arn: profileArn }] })
      }
      return eventStream(content("OK"))
    }) as typeof fetch)
    for (let i = 0; i <= 32; i++) assert.equal((await turn(`rotated-token-${i}`)).stopReason, "stop")
    await turn("rotated-token-32")
    assert.equal(lookups, 33)
    await turn("rotated-token-0")
    assert.equal(lookups, 34)
  })
})

describe("stale token during profile lookup", () => {
  const hasSqlite = spawnSync("sqlite3", ["--version"]).status === 0
  const profileArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/default"
  const invalidBearer = { message: "The bearer token included in the request is invalid." }

  /** Installs a kiro-cli whose `whoami` renews an expired CLI token to `cli-fresh`. */
  const installKiroCli = (t: { after: (fn: () => void) => void }) => {
    const cliDir = join(home, ".local", "share", "kiro-cli")
    const bin = join(home, "bin")
    const db = join(cliDir, "data.sqlite3")
    const previousPath = process.env.PATH
    mkdirSync(cliDir, { recursive: true })
    mkdirSync(bin, { recursive: true })
    t.after(() => {
      process.env.PATH = previousPath
      rmSync(cliDir, { recursive: true, force: true })
      rmSync(bin, { recursive: true, force: true })
    })
    const token = (access: string, expiresAt: number) =>
      JSON.stringify({ access_token: access, expires_at: new Date(expiresAt).toISOString() })
    execFileSync("sqlite3", [db, "CREATE TABLE auth_kv (key TEXT, value TEXT);"
      + ` INSERT INTO auth_kv VALUES ('kirocli:odic:token', '${token("cli-expired", Date.now() - 1000)}');`])
    writeFileSync(join(bin, "renew.sql"), `UPDATE auth_kv SET value = '${token("cli-fresh", Date.now() + 3_600_000)}';`)
    writeFileSync(join(bin, "kiro-cli"), `#!/bin/sh\nexec sqlite3 '${db}' < '${join(bin, "renew.sql")}'\n`, { mode: 0o755 })
    process.env.PATH = `${bin}:${previousPath}`
  }

  it("resyncs kiro-cli instead of failing the lookup", { skip: !hasSqlite }, async (t) => {
    installKiroCli(t)
    const inferenceTokens: (string | null)[] = []
    const output = await streamOnce((async (input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("Authorization")
      if (new URL(String(input)).pathname === "/List-Available-Profiles") {
        return authorization === "Bearer cli-fresh" ? response({ profiles: [{ arn: profileArn }] }) : response(invalidBearer, 403)
      }
      inferenceTokens.push(authorization)
      return eventStream(content("OK"))
    }) as typeof fetch, "cli-expired")
    assert.equal(output.stopReason, "stop", output.errorMessage)
    assert.deepEqual(inferenceTokens, ["Bearer cli-fresh"])
  })

  it("reports a rejected token from another login instead of switching to the CLI identity", { skip: !hasSqlite }, async (t) => {
    installKiroCli(t)
    const output = await streamOnce((async (input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("Authorization")
      if (new URL(String(input)).pathname === "/List-Available-Profiles") {
        return authorization === "Bearer cli-fresh" ? response({ profiles: [{ arn: profileArn }] }) : response(invalidBearer, 403)
      }
      return eventStream(content("OK"))
    }) as typeof fetch, "organization-token")
    assert.equal(output.stopReason, "error")
    assert.match(output.errorMessage ?? "", /bearer token included in the request is invalid/)
  })

  it("reports a rejected API key instead of switching to the CLI identity", { skip: !hasSqlite }, async (t) => {
    installKiroCli(t)
    for (const rejectedAt of ["GetProfile", "inference"]) {
      const inferenceTokens: (string | null)[] = []
      const output = await streamOnce((async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        const authorization = headers.get("Authorization")
        if (headers.get("X-Amz-Target") === "AmazonCodeWhispererService.GetProfile") {
          return rejectedAt === "GetProfile" ? response(invalidBearer, 403) : response({ profile: { arn: profileArn } })
        }
        if (new URL(String(input)).pathname === "/List-Available-Profiles") return response({ profiles: [{ arn: profileArn }] })
        inferenceTokens.push(authorization)
        return authorization === "Bearer cli-fresh" ? eventStream(content("OK")) : response(invalidBearer, 403)
      }) as typeof fetch, `ksk_revoked_at_${rejectedAt}`)
      assert.equal(output.stopReason, "error", rejectedAt)
      assert.ok(!inferenceTokens.includes("Bearer cli-fresh"), rejectedAt)
    }
  })
})

describe("kiro-cli on macOS with a GitHub or Google login", () => {
  const hasSqlite = spawnSync("sqlite3", ["--version"]).status === 0
  const cliDir = join(home, "Library", "Application Support", "kiro-cli")
  const db = join(cliDir, "data.sqlite3")
  const profileArn = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/social"
  const socialToken = (access: string, expiresAt: number) => JSON.stringify({
    access_token: access, refresh_token: `${access}-refresh`,
    expires_at: new Date(expiresAt).toISOString(), provider: "github", profile_arn: profileArn,
  })

  /** Saves a social login where kiro-cli 2.x keeps it on macOS; `renewTo` makes `kiro-cli whoami` renew it. */
  const installSocialLogin = (t: { after: (fn: () => void) => void }, token: string, renewTo?: string) => {
    mkdirSync(cliDir, { recursive: true })
    t.after(() => rmSync(cliDir, { recursive: true, force: true }))
    execFileSync("sqlite3", [db, "CREATE TABLE auth_kv (key TEXT, value TEXT); CREATE TABLE state (key TEXT, value TEXT);"
      + ` INSERT INTO auth_kv VALUES ('kirocli:social:token', '${token}');`])
    if (!renewTo) return
    const bin = join(home, "renewing-kiro-cli")
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, "renew.sql"), `UPDATE auth_kv SET value = '${renewTo}';`)
    writeFileSync(join(bin, "kiro-cli"), `#!/bin/sh\nexec sqlite3 '${db}' < '${join(bin, "renew.sql")}'\n`, { mode: 0o755 })
    const path = process.env.PATH
    process.env.PATH = `${bin}:${path}`
    t.after(() => {
      process.env.PATH = path
      rmSync(bin, { recursive: true, force: true })
    })
  }

  it("refreshes a credential saved without metadata from the live kiro-cli login", { skip: !hasSqlite }, async (t) => {
    installSocialLogin(t, socialToken("cli-access", Date.now() + 3_600_000))
    const renewed = await refreshToken({ access: "stale", refresh: "stale", expires: 0 })
    assert.equal(renewed.access, "cli-access")
    assert.equal(renewed.reused, true)
    assert.equal(renewed.method, "social")
    assert.equal(renewed.region, "us-east-1")
    assert.equal(renewed.profileArn, profileArn)
  })

  it("lets kiro-cli renew an expired login instead of rotating its refresh token", { skip: !hasSqlite }, async (t) => {
    installSocialLogin(t, socialToken("cli-expired", Date.now() - 1000), socialToken("cli-fresh", Date.now() + 3_600_000))
    const fetchMock = t.mock.method(globalThis, "fetch", async () => response({ accessToken: "self-renewed" }))
    const renewed = await refreshToken({ access: "cli-expired", refresh: "cli-expired-refresh", expires: 0 })
    assert.equal(renewed.access, "cli-fresh")
    assert.equal(renewed.reused, true)
    assert.equal(fetchMock.mock.callCount(), 0)
  })

  it("renews with the us-east-1 social endpoint for an EU profile when kiro-cli cannot, and keeps following kiro-cli", { skip: !hasSqlite }, async (t) => {
    installSocialLogin(t, socialToken("cli-expired", Date.now() - 1000))
    const urls: string[] = []
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return response({ accessToken: "self-renewed", expiresIn: 3600 })
    })
    const renewed = await refreshToken({ access: "cli-expired", refresh: "cli-expired-refresh", expires: 0 })
    assert.equal(renewed.access, "self-renewed")
    assert.equal(renewed.reused, true)
    assert.deepEqual(urls, ["https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken"])
  })

  /** Streams one turn with `apiKey` and returns the Authorization header inference received. */
  const inferenceToken = async (apiKey: string) => {
    const tokens: (string | null)[] = []
    const output = await streamOnce((async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname === "/List-Available-Profiles") return response({ profiles: [{ arn: profileArn }] })
      tokens.push(new Headers(init?.headers).get("Authorization"))
      return eventStream(content("OK"))
    }) as typeof fetch, apiKey)
    assert.equal(output.stopReason, "stop", output.errorMessage)
    return tokens[0]
  }

  it("keeps the account signed in with /login when kiro-cli holds another", { skip: !hasSqlite }, async (t) => {
    installSocialLogin(t, socialToken("cli-access", Date.now() + 3_600_000))
    assert.equal(await inferenceToken("organization-token"), "Bearer organization-token")
    assert.equal(await inferenceToken(JSON.stringify({ access: "organization-token", method: "idc" })), "Bearer organization-token")
  })

  it("sends kiro-cli's live token for a login reused from it, or when OMP holds none", { skip: !hasSqlite }, async (t) => {
    installSocialLogin(t, socialToken("cli-access", Date.now() + 3_600_000))
    assert.equal(await inferenceToken(JSON.stringify({ access: "cli-old", method: "social", reused: true })), "Bearer cli-access")
    assert.equal(await inferenceToken(""), "Bearer cli-access")
  })

  it("gives OMP kiro-cli's live token only for credentials that follow kiro-cli", { skip: !hasSqlite }, async (t) => {
    installSocialLogin(t, socialToken("cli-access", Date.now() + 3_600_000))
    assert.equal(getApiKey({ access: "cli-old", refresh: "r", expires: 0, method: "social", reused: true }), "cli-access")
    assert.equal(getApiKey({ access: "cli-old", refresh: "r", expires: 0 }), "cli-access")
    assert.equal(getApiKey({ access: "organization-token", refresh: "r", expires: 0, method: "idc" }), "organization-token")
    assert.equal(getApiKey({ access: "ksk_key", refresh: "ksk_key", expires: 0 }), "ksk_key")
  })

  it("reads the kiro-cli login without the sqlite3 command", { skip: !hasSqlite }, async (t) => {
    installSocialLogin(t, socialToken("cli-access", Date.now() + 3_600_000))
    const path = process.env.PATH
    process.env.PATH = noKiroCli
    t.after(() => { process.env.PATH = path })
    assert.equal(getApiKey({ access: "cli-old", refresh: "r", expires: 0, method: "social", reused: true }), "cli-access")
  })

  it("names the macOS location when /login finds no kiro-cli login", async () => {
    await assert.rejects(
      login({ onPrompt: async () => "1", onAuth: () => {}, onProgress: () => {} } as never),
      /Library\/Application Support\/kiro-cli\/data\.sqlite3/,
    )
  })
})

describe("stream gate", () => {
  it("takes over at once from an owner that exited without releasing it", { timeout: 10_000 }, async (t) => {
    const gateDir = join(tmpdir(), "kiro-for-omp", "stream.lock")
    mkdirSync(gateDir, { recursive: true })
    t.after(() => rmSync(gateDir, { recursive: true, force: true }))
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid
    writeFileSync(join(gateDir, "owner.json"), JSON.stringify({ token: "crashed", pid: deadPid, heartbeatAt: new Date().toISOString() }))

    const output = await kiroTurns((async (input: RequestInfo | URL) =>
      new URL(String(input)).pathname === "/List-Available-Profiles"
        ? response({ profiles: [{ arn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/default" }] })
        : eventStream(content("OK"))) as typeof fetch, {}, { env: {} })("token")
    assert.equal(output.stopReason, "stop", output.errorMessage)
  })
})
