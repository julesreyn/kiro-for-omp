/**
 * AWS SSO OIDC Device Code Flow for Builder ID and IAM Identity Center login.
 *
 * Adapted from AERT-7Y/kiro-auto/lib/auth.ts. The Kiro IDE signs in with the same flow.
 *
 * Flow:
 *   1. Register client → { clientId, clientSecret }
 *   2. Start device auth → { deviceCode, userCode, verificationUri }
 *   3. Open browser for user verification
 *   4. Poll for token → { accessToken, refreshToken, expiresIn }
 *
 * The client registers under the name "Kiro", as the Kiro IDE does.
 */

import type { KiroCredentials, OAuthLoginCallbacks } from "../types.ts"

const CODEWHISPERER_SCOPES = [
  "codewhisperer:completions",
  "codewhisperer:analysis",
  "codewhisperer:conversations",
  "codewhisperer:transformations",
  "codewhisperer:taskassist",
]

const START_URL = "https://view.awsapps.com/start"
const DEFAULT_REGION = "us-east-1"

async function registerClient(region: string, startUrl: string): Promise<{
  clientId: string
  clientSecret: string
}> {
  const url = `https://oidc.${region}.amazonaws.com/client/register`

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientName: "Kiro",
      clientType: "public",
      scopes: CODEWHISPERER_SCOPES,
      grantTypes: [
        "urn:ietf:params:oauth:grant-type:device_code",
        "refresh_token",
      ],
      issuerUrl: startUrl,
    }),
  })

  if (!res.ok) {
    throw new Error(`OIDC client registration failed (${res.status}): ${await res.text().catch(() => "")}`)
  }

  const data = await res.json() as { clientId: string; clientSecret: string }
  if (!data.clientId || !data.clientSecret) {
    throw new Error("OIDC client registration returned missing clientId/clientSecret")
  }

  return data
}

async function startDeviceAuth(
  region: string,
  clientId: string,
  clientSecret: string,
  startUrl: string,
): Promise<{
  deviceCode: string
  userCode: string
  verificationUri: string
  interval: number
  expiresIn: number
}> {
  const url = `https://oidc.${region}.amazonaws.com/device_authorization`

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId, clientSecret, startUrl }),
  })

  if (!res.ok) {
    throw new Error(`Device authorization failed (${res.status}): ${await res.text().catch(() => "")}`)
  }

  const data = await res.json() as {
    deviceCode: string
    userCode: string
    verificationUri: string
    verificationUriComplete?: string
    interval?: number
    expiresIn?: number
  }

  if (!data.deviceCode || !data.userCode || !data.verificationUri) {
    throw new Error("Device authorization returned missing deviceCode/userCode/verificationUri")
  }

  return {
    deviceCode: data.deviceCode,
    userCode: data.userCode,
    verificationUri: data.verificationUriComplete ?? data.verificationUri,
    interval: data.interval ?? 5,
    expiresIn: data.expiresIn ?? 600,
  }
}

async function pollForToken(
  region: string,
  clientId: string,
  clientSecret: string,
  deviceCode: string,
): Promise<KiroCredentials> {
  const url = `https://oidc.${region}.amazonaws.com/token`

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId,
      clientSecret,
      grantType: "urn:ietf:params:oauth:grant-type:device_code",
      deviceCode,
    }),
  })

  if (res.status === 200) {
    const data = await res.json() as {
      accessToken: string
      refreshToken: string
      expiresIn: number
    }

    return {
      access: data.accessToken,
      refresh: data.refreshToken,
      expiresAt: Date.now() + data.expiresIn * 1000 - 60_000,
      method: "idc",
      clientId,
      clientSecret,
      region,
    }
  }

  if (res.status === 400) {
    const errData = await res.json().catch(() => ({})) as { error?: string }
    const error = errData.error

    if (error === "authorization_pending") throw new PendingError()
    if (error === "slow_down") throw new SlowDownError()
    if (error === "expired_token") throw new Error("Device code expired. Please try again.")
    if (error === "access_denied") throw new Error("Authorization denied by user.")
    throw new Error(`OIDC token error: ${error ?? "unknown"}`)
  }

  throw new Error(`OIDC token poll returned unexpected status ${res.status}`)
}

// Thrown by pollForToken to steer the poll loop.
class PendingError extends Error { constructor() { super("pending") } }
class SlowDownError extends Error { constructor() { super("slow_down") } }

export async function runDeviceCodeFlow(
  callbacks: OAuthLoginCallbacks,
  region = DEFAULT_REGION,
  startUrl = START_URL,
): Promise<KiroCredentials> {
  const { clientId, clientSecret } = await registerClient(region, startUrl)

  const auth = await startDeviceAuth(region, clientId, clientSecret, startUrl)

  // Show the link with the code to confirm; polling starts right away, no extra keypress.
  await callbacks.onAuth({
    url: auth.verificationUri,
    instructions: `Confirm the code ${auth.userCode} in your browser and approve access for Kiro.`,
  })
  callbacks.onProgress?.("Waiting for browser authorization...")

  let interval = auth.interval * 1000
  const deadline = Date.now() + auth.expiresIn * 1000

  while (Date.now() < deadline) {
    await sleep(interval)

    try {
      return await pollForToken(region, clientId, clientSecret, auth.deviceCode)
    } catch (err) {
      if (err instanceof PendingError) continue
      if (err instanceof SlowDownError) {
        interval = Math.min(interval + 5000, 30_000)
        continue
      }
      throw err
    }
  }

  throw new Error("Device code flow timed out")
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
