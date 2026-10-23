/**
 * Kiro OAuth provider for OMP's /login flow.
 *
 * OMP's OAuthCredentials uses `expires` (not `expiresAt`) and has no
 * method/clientId/region fields. We store Kiro-specific auth metadata
 * in a sidecar JSON file at ~/.omp/agent/kiro-auth-meta.json.
 *
 * Auth sources (in preference order):
 * 1. kiro-cli's SQLite database, which kiro-cli keeps fresh
 * 2. Kiro IDE's ~/.aws/sso/cache/kiro-auth-token-cli.json or kiro-auth-token.json
 * 3. API key (ksk_…)
 * 4. OIDC device code flow (Builder ID or IAM Identity Center browser login)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
import { execFile, execFileSync } from "node:child_process"
import { promisify } from "node:util"

import type { KiroAuthMeta, KiroCredentials, OAuthLoginCallbacks } from "./types.ts"
import { runDeviceCodeFlow } from "./auth/device-flow.ts"
import { refreshKiroToken } from "./auth/token-refresh.ts"
import { isKiroApiKey } from "./auth/token-type.ts"

const execFileAsync = promisify(execFile)

const FAR_FUTURE_MS = 10 * 365 * 24 * 60 * 60 * 1000
const DEFAULT_REGION = "us-east-1"
const META_PATH = join(homedir(), ".omp", "agent", "kiro-auth-meta.json")

function readMeta(): KiroAuthMeta | null {
  try {
    if (!existsSync(META_PATH)) return null
    return JSON.parse(readFileSync(META_PATH, "utf-8")) as KiroAuthMeta
  } catch {
    return null
  }
}

function writeMeta(meta: KiroAuthMeta): void {
  try {
    const dir = dirname(META_PATH)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(META_PATH, JSON.stringify(meta, null, 2), { mode: 0o600 })
  } catch {
    // Best effort
  }
}

/**
 * Every Kiro login shares one identity so OMP replaces the previous credential instead of adding
 * another. OMP keeps a single model catalog per provider, and accounts on different plans expose
 * different models, so several accounts would make the catalog depend on which one answered.
 */
const KIRO_ACCOUNT_ID = "kiro"

interface OMPCredentials {
  access: string
  refresh: string
  expires: number
  accountId?: string
  method?: string
  region?: string
  clientId?: string
  clientSecret?: string
  profileArn?: string
  /** Taken from Kiro CLI or IDE, which keep refreshing the same token lineage. */
  reused?: boolean
}

/** OMP stores whatever the provider returns, so the refresh method travels with each credential. */
function embedMeta(creds: OMPCredentials, meta: KiroAuthMeta): OMPCredentials {
  return {
    ...creds,
    accountId: KIRO_ACCOUNT_ID,
    method: meta.method,
    ...(meta.region ? { region: meta.region } : {}),
    ...(meta.clientId ? { clientId: meta.clientId } : {}),
    ...(meta.clientSecret ? { clientSecret: meta.clientSecret } : {}),
    ...(meta.profileArn ? { profileArn: meta.profileArn } : {}),
  }
}

function metaOf(creds: OMPCredentials): KiroAuthMeta | undefined {
  if (!creds.method) return undefined
  return {
    method: creds.method,
    region: creds.region,
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    profileArn: creds.profileArn,
  }
}

function credentialsFromApiKey(apiKey: string): OMPCredentials {
  writeMeta({ method: "apikey" })
  return embedMeta({ access: apiKey, refresh: apiKey, expires: Date.now() + FAR_FUTURE_MS }, { method: "apikey" })
}

/** Remove terminal paste wrappers, surrounding whitespace, control chars. */
function sanitizeApiKey(input: string): string {
  return input
    .replace(/^['"`]+|['"`]+$/g, "")
    .replace(/[\x00-\x1F\x7F]/g, "")
    .trim()
}

interface CliToken {
  access_token: string
  refresh_token: string
  expires_at: string
  region?: string
  start_url?: string
  /** Social (GitHub/Google) logins carry their profile in the token. */
  profile_arn?: string
}

interface CliRegistration {
  client_id: string
  client_secret: string
  region: string
}

interface CliProfile {
  arn: string
}

interface ReadonlySqlite {
  prepare(sql: string): { get(): Record<string, unknown> | null | undefined }
  close(): void
}

/**
 * Opens a database read-only with the SQLite built into the runtime: `node:sqlite` (Node 22.13+,
 * newer Bun) or `bun:sqlite` (Bun, which OMP runs on). Undefined when neither is available.
 */
function openBuiltinSqlite(dbPath: string): ReadonlySqlite | undefined {
  const getBuiltinModule = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule
  if (typeof getBuiltinModule !== "function") return undefined
  const load = (id: string): Record<string, unknown> | undefined => {
    try {
      return getBuiltinModule(id) as Record<string, unknown> | undefined
    } catch {
      return undefined
    }
  }
  type Open = new (path: string, options: Record<string, boolean>) => ReadonlySqlite
  const nodeSqlite = load("node:sqlite")?.DatabaseSync as Open | undefined
  if (nodeSqlite) return new nodeSqlite(dbPath, { readOnly: true })
  const bunSqlite = load("bun:sqlite")?.Database as Open | undefined
  if (bunSqlite) return new bunSqlite(dbPath, { readonly: true })
  return undefined
}

/** The first column of the first row `query` returns, or null. */
function sqliteValue(dbPath: string, query: string): string | null {
  try {
    const db = openBuiltinSqlite(dbPath)
    if (db) {
      try {
        const row = db.prepare(query).get()
        const value = row ? Object.values(row)[0] : undefined
        return typeof value === "string" ? value.trim() || null : null
      } finally {
        db.close()
      }
    }
  } catch { /* fall back to the sqlite3 command */ }
  return sqlite3Raw(dbPath, query)
}

function sqlite3Raw(dbPath: string, query: string): string | null {
  try {
    const out = execFileSync("sqlite3", [dbPath, query], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    })
    return out.trim() || null
  } catch {
    return null
  }
}

// kiro-cli keeps its database in the platform data directory: ~/.local/share on Linux,
// ~/Library/Application Support on macOS.
const CLI_DB_PATHS = [
  join(homedir(), ".local", "share", "kiro-cli", "data.sqlite3"),
  join(homedir(), ".local", "share", "amazon-q", "data.sqlite3"),
  join(homedir(), "Library", "Application Support", "kiro-cli", "data.sqlite3"),
  join(homedir(), "Library", "Application Support", "amazon-q", "data.sqlite3"),
]

/** kiro-cli stores a Builder ID / Identity Center login and a GitHub/Google login under different keys. */
const CLI_TOKEN_KEYS = [
  { key: "kirocli:odic:token", method: "idc" },
  { key: "kirocli:social:token", method: "social" },
] as const

/** Every login kiro-cli has saved with an access token, in preference order. */
function* readCliTokens(): Generator<{ dbPath: string; method: "idc" | "social"; token: CliToken }> {
  for (const dbPath of CLI_DB_PATHS) {
    if (!existsSync(dbPath)) continue
    for (const { key, method } of CLI_TOKEN_KEYS) {
      const tokenRaw = sqliteValue(dbPath, `SELECT value FROM auth_kv WHERE key='${key}';`)
      if (!tokenRaw) continue
      try {
        const token = JSON.parse(tokenRaw) as CliToken
        if (token.access_token) yield { dbPath, method, token }
      } catch { /* skip */ }
    }
  }
}

/** The first kiro-cli login that can be refreshed, with its metadata. */
function tryReadCliCredentials(): { creds: OMPCredentials; meta: KiroAuthMeta } | null {
  for (const { dbPath, method, token } of readCliTokens()) {
    if (!token.refresh_token) continue

    const expiresAt = new Date(token.expires_at).getTime()

    // The OIDC client registration, needed to refresh an IAM Identity Center login.
    const regRaw = method === "idc"
      ? sqliteValue(dbPath, "SELECT value FROM auth_kv WHERE key='kirocli:odic:device-registration';")
      : null
    let clientId: string | undefined
    let clientSecret: string | undefined
    if (regRaw) {
      try {
        const reg = JSON.parse(regRaw) as CliRegistration
        clientId = reg.client_id
        clientSecret = reg.client_secret
      } catch { /* skip */ }
    }

    let profileArn = token.profile_arn
    const profileRaw = profileArn ? null : sqliteValue(dbPath, "SELECT value FROM state WHERE key='api.codewhisperer.profile';")
    if (profileRaw) {
      try {
        const profile = JSON.parse(profileRaw) as CliProfile
        profileArn = profile.arn
      } catch { /* skip */ }
    }

    const meta: KiroAuthMeta = {
      method,
      // The sign-in region, used only to refresh. Social logins carry none: Kiro's social auth
      // service runs in us-east-1 alone, whichever region the profile lives in.
      region: token.region ?? DEFAULT_REGION,
      profileArn,
      clientId,
      clientSecret,
    }

    return {
      creds: {
        access: token.access_token,
        refresh: token.refresh_token,
        expires: expiresAt,
      },
      meta,
    }
  }

  return null
}

/** kiro-cli's access token, unless it expires within a minute. */
export function readCliAccessToken(): string | undefined {
  for (const { token } of readCliTokens()) {
    const expires = token.expires_at as string | number | undefined
    const expMs = typeof expires === "string" ? new Date(expires).getTime() : (expires ?? 0) * 1000
    if (!expires || expMs > Date.now() + 60_000) return token.access_token
  }
  return undefined
}

/** Whether `token` is one kiro-cli holds, live or expired: requests made with it are kiro-cli's identity. */
export function isCliAccessToken(token: string): boolean {
  for (const { token: cli } of readCliTokens()) {
    if (cli.access_token === token) return true
  }
  return false
}

/**
 * Ask kiro-cli to renew its own session. Renewing a reused token here would rotate the refresh
 * token under kiro-cli and sign one of the two out, so kiro-cli does it and we reread.
 * Asynchronous: `kiro-cli whoami` takes seconds, and OMP's UI and other streams must keep running.
 */
export async function resyncCliLogin(): Promise<void> {
  try {
    await execFileAsync("kiro-cli", ["whoami"], { timeout: 15_000 })
  } catch { /* not installed or signed out */ }
}

/** Kiro IDE token files in ~/.aws/sso/cache, the newer kiro-cli format first. */
const IDE_TOKEN_FILES = [
  "kiro-auth-token-cli.json",
  "kiro-auth-token.json",
]

function tryReadIdeToken(): { creds: OMPCredentials; meta: KiroAuthMeta } | null {
  const ssoDir = join(homedir(), ".aws", "sso", "cache")

  for (const filename of IDE_TOKEN_FILES) {
    const cachePath = join(ssoDir, filename)
    if (!existsSync(cachePath)) continue

    try {
      const raw = readFileSync(cachePath, "utf-8")
      const data = JSON.parse(raw) as {
        accessToken?: string
        refreshToken?: string
        expiresAt?: string | number
        region?: string
        profileArn?: string
        clientId?: string
        clientSecret?: string
      }

      if (!data.accessToken && !data.refreshToken) continue

      let expires: number
      if (typeof data.expiresAt === "string") expires = new Date(data.expiresAt).getTime()
      else if (typeof data.expiresAt === "number") expires = data.expiresAt
      else expires = 0

      const method = data.clientId ? "idc" : "social"
      const meta: KiroAuthMeta = {
        method,
        region: data.region ?? DEFAULT_REGION,
        profileArn: data.profileArn,
        clientId: data.clientId,
        clientSecret: data.clientSecret,
      }

      return {
        creds: { access: data.accessToken ?? "", refresh: data.refreshToken ?? "", expires },
        meta,
      }
    } catch {
      continue
    }
  }

  return null
}

function toFull(creds: OMPCredentials, meta: KiroAuthMeta): KiroCredentials {
  return {
    access: creds.access,
    refresh: creds.refresh,
    expiresAt: creds.expires,
    method: meta.method,
    clientId: meta.clientId,
    clientSecret: meta.clientSecret,
    region: meta.region,
    profileArn: meta.profileArn,
  }
}

function fromFull(full: KiroCredentials): { creds: OMPCredentials; meta: KiroAuthMeta } {
  const meta: KiroAuthMeta = {
    method: full.method,
    clientId: full.clientId,
    clientSecret: full.clientSecret,
    region: full.region,
    profileArn: full.profileArn,
  }
  return {
    creds: embedMeta({ access: full.access, refresh: full.refresh, expires: full.expiresAt }, meta),
    meta,
  }
}

function tryAutoDetect(): { creds: OMPCredentials; meta: KiroAuthMeta } | null {
  const cli = tryReadCliCredentials()
  if (cli && cli.creds.expires > Date.now()) return cli
  // An installed kiro-cli with an expired token must not hide a live IDE token.
  const ide = tryReadIdeToken()
  if (ide && ide.creds.expires > Date.now()) return ide
  return cli ?? ide
}

export async function login(callbacks: OAuthLoginCallbacks): Promise<OMPCredentials | string> {
  const existing = tryAutoDetect()

  const choice = await callbacks.onPrompt({
    message:
      "Sign in to Kiro\n\n" +
      `  1  Reuse existing login (Kiro CLI or IDE)${existing ? "  · detected" : ""}\n` +
      "  2  API key (ksk_…)\n" +
      "  3  Refresh token\n" +
      "  4  AWS Builder ID  · browser\n" +
      "  5  Your organization (IAM Identity Center)  · browser\n\n" +
      "Choose an option:",
  })

  switch (choice.trim()) {
    case "1": {
      const detected = tryAutoDetect()
      if (!detected) {
        const ssoDir = join(homedir(), ".aws", "sso", "cache")
        const details: string[] = []
        const dbPath = CLI_DB_PATHS.find(existsSync)
        if (dbPath) {
          details.push(`kiro-cli DB exists at ${dbPath} but no valid token found (may need to run 'kiro-cli login')`)
        } else {
          details.push(`kiro-cli DB not found at ${CLI_DB_PATHS.join(" or ")}`)
        }
        for (const f of IDE_TOKEN_FILES) {
          const p = join(ssoDir, f)
          if (existsSync(p)) {
            details.push(`Kiro token file ${f} exists but could not be parsed`)
          } else {
            details.push(`Kiro token file not found: ${f}`)
          }
        }
        throw new Error(
          "No existing Kiro login found:\n" + details.map(d => `  - ${d}`).join("\n") +
          "\nLog in with kiro-cli or Kiro IDE first, or use another method.",
        )
      }
      writeMeta(detected.meta)

      // If expired, refresh immediately
      if (detected.creds.expires <= Date.now()) {
        const refreshed = await refreshKiroToken(toFull(detected.creds, detected.meta))
        const result = fromFull(refreshed)
        writeMeta(result.meta)
        return { ...result.creds, reused: true }
      }
      return { ...embedMeta(detected.creds, detected.meta), reused: true }
    }

    case "2": {
      const raw = await callbacks.onPrompt({ message: "Paste your Kiro API key:", placeholder: "ksk_…", secret: true })
      const apiKey = sanitizeApiKey(raw)
      if (!apiKey) throw new Error("No API key provided")
      return credentialsFromApiKey(apiKey)
    }

    case "3": {
      const raw = await callbacks.onPrompt({ message: "Paste your refresh token:", secret: true })
      const refreshToken = sanitizeApiKey(raw)
      if (!refreshToken) throw new Error("No refresh token provided")

      const regionRaw = await callbacks.onPrompt({ message: `Region (default: ${DEFAULT_REGION}):` })
      const region = regionRaw.trim() || DEFAULT_REGION

      writeMeta({ method: "social", region })
      return embedMeta({ access: "", refresh: refreshToken, expires: 0 }, { method: "social", region })
    }

    case "4": {
      const full = await runDeviceCodeFlow(callbacks)
      const result = fromFull(full)
      writeMeta(result.meta)
      return result.creds
    }

    case "5": {
      const startUrl = (await callbacks.onPrompt({
        message: "IAM Identity Center start URL:",
        placeholder: "https://your-organization.awsapps.com/start",
      })).trim()
      let validStartUrl = false
      try { validStartUrl = new URL(startUrl).protocol === "https:" } catch { /* invalid URL */ }
      if (!validStartUrl) {
        throw new Error("IAM Identity Center start URL must be an HTTPS URL.")
      }
      const region = (await callbacks.onPrompt({
        message: `IAM Identity Center region (default: ${DEFAULT_REGION}):`,
        placeholder: DEFAULT_REGION,
        allowEmpty: true,
      })).trim().toLowerCase() || DEFAULT_REGION
      if (!/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region)) {
        throw new Error("Enter the AWS region of your IAM Identity Center instance.")
      }
      callbacks.onProgress?.(`Starting organization sign-in in ${region}...`)
      const full = await runDeviceCodeFlow(callbacks, region, startUrl)
      const result = fromFull(full)
      writeMeta(result.meta)
      return result.creds
    }

    default:
      throw new Error(`Invalid choice: ${choice}`)
  }
}

export async function refreshToken(credentials: OMPCredentials): Promise<OMPCredentials> {
  // A credential carries its own refresh method. The shared sidecar only describes the most
  // recent login, so it is a fallback for older credentials that carry none.
  const own = metaOf(credentials)

  // Kiro CLI and IDE refresh (and rotate) the same token themselves, so credentials reused from
  // either defer to the live state first. Older credentials without metadata consult only kiro-cli.
  let live: ReturnType<typeof tryAutoDetect> = null
  if (!own || credentials.reused) {
    const readLive = () => credentials.reused ? tryAutoDetect() : tryReadCliCredentials()
    live = readLive()
    if (live && live.creds.expires <= Date.now() && tryReadCliCredentials()) {
      await resyncCliLogin()
      live = readLive()
    }
    if (live && live.creds.expires > Date.now()) {
      writeMeta(live.meta)
      return { ...embedMeta(live.creds, live.meta), reused: true }
    }
  }

  // A credential without metadata that holds the kiro-cli refresh token (one OMP imported from
  // kiro-cli, say) is that login: refresh it the way kiro-cli would, and keep following kiro-cli.
  const fromLive = !own && live !== null && live.creds.refresh === credentials.refresh
  const meta = own ?? (fromLive ? live?.meta : readMeta() ?? live?.meta)
  if (!meta) throw new Error("No Kiro auth metadata found. Run /login first.")

  const refreshed = await refreshKiroToken(toFull(credentials, meta))
  const result = fromFull(refreshed)
  // getStoredProfileArn() reads the sidecar, so a renewed profile ARN must reach it too.
  writeMeta(result.meta)
  return credentials.reused || fromLive ? { ...result.creds, reused: true } : result.creds
}

/**
 * The token to send for a credential. One that follows kiro-cli (reused from it, or an older one
 * without a method) sends kiro-cli's current token, which kiro-cli keeps fresh.
 * Any other login sends its own, so kiro-cli never replaces the account chosen in /login.
 */
export function accessTokenFor(credentials: OMPCredentials): string {
  const followsCli = credentials.reused || (!credentials.method && !isKiroApiKey(credentials.access))
  return (followsCli ? readCliAccessToken() : undefined) ?? credentials.access
}

export function getApiKey(credentials: OMPCredentials): string {
  return accessTokenFor(credentials)
}

export function getStoredProfileArn(): string | undefined {
  const arn = readMeta()?.profileArn
  return typeof arn === "string" && arn.trim() !== "" ? arn.trim() : undefined
}
