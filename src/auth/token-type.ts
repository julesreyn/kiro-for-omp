/**
 * Kiro credential types.
 *
 * Kiro API keys (`ksk_…`) must be declared with `TokenType: API_KEY`, as kiro-cli does. Without it
 * the API treats the key as an OAuth access token and rejects it (403 "The bearer token included
 * in the request is invalid."). OAuth access tokens must not carry the header.
 */

export function isKiroApiKey(token: string): boolean {
  return token.startsWith("ksk_")
}

/**
 * The credential headers for a request. A token that is not a valid header value throws here,
 * before fetch, because fetch's error quotes the whole value, credential included.
 */
export function kiroAuthHeaders(token: string): Record<string, string> {
  if (/[^\x20-\x7e]/.test(token)) throw new Error("Kiro credential contains characters that are not valid in an HTTP header")
  return { Authorization: `Bearer ${token}`, ...(isKiroApiKey(token) ? { TokenType: "API_KEY" } : {}) }
}
