/**
 * Fallback parser for bracket-style tool calls in content text.
 *
 * Some models emit tool calls as `[Called func_name with args: {...}]`
 * instead of native tool events. This parser extracts those patterns and
 * returns cleaned text with the bracket patterns removed.
 *
 * Adapted from mikeyobrien/pi-provider-kiro/src/bracket-tool-parser.ts.
 */

export interface BracketToolCall {
  toolUseId: string
  name: string
  arguments: Record<string, unknown>
}

export interface BracketParseResult {
  toolCalls: BracketToolCall[]
  cleanedText: string
}

const BRACKET_PATTERN = /\[Called\s+([\w-]+)\s+with\s+args:\s*/g

/**
 * Find the index after the matching closing brace for `{` at `start`.
 * Handles nested braces and escaped characters within strings.
 */
function findJsonEnd(text: string, start: number): number {
  if (text.charCodeAt(start) !== 0x7b) return -1 // '{'
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    if (escape) {
      escape = false
      continue
    }
    if (ch === 0x5c) { // '\'
      if (inString) escape = true
      continue
    }
    if (ch === 0x22) { // '"'
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === 0x7b) depth++    // '{'
    else if (ch === 0x7d) {     // '}'
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** A call quoted as Markdown code is an example rather than an invocation. */
function isQuotedAsCode(text: string, index: number): boolean {
  const before = text.slice(0, index)
  const fences = before.match(/^ {0,3}(```|~~~)/gm)?.length ?? 0
  const line = before.slice(before.lastIndexOf("\n") + 1)
  return fences % 2 === 1 || /^( {4}|\t)\s*$/.test(line) || line.split("`").length % 2 === 0
}

/**
 * Extract bracket-style tool calls from content text.
 * Returns parsed tool calls and the text with bracket patterns removed.
 */
export function parseBracketToolCalls(text: string): BracketParseResult {
  const toolCalls: BracketToolCall[] = []
  const removals: Array<{ start: number; end: number }> = []

  BRACKET_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null = BRACKET_PATTERN.exec(text)
  while (match !== null) {
    const name = match[1]
    const jsonStart = match.index + match[0].length

    const braceIdx = text.indexOf("{", jsonStart)
    if (braceIdx >= 0 && braceIdx === jsonStart && !isQuotedAsCode(text, match.index)) {
      const jsonEndIdx = findJsonEnd(text, braceIdx)
      if (jsonEndIdx >= 0) {
        const afterJson = text.indexOf("]", jsonEndIdx + 1)
        if (afterJson >= 0) {
          const between = text.substring(jsonEndIdx + 1, afterJson).trim()
          if (between.length === 0) {
            const jsonStr = text.substring(braceIdx, jsonEndIdx + 1)
            try {
              const args = JSON.parse(jsonStr) as Record<string, unknown>
              toolCalls.push({
                toolUseId: crypto.randomUUID(),
                name,
                arguments: args,
              })
              removals.push({ start: match.index, end: afterJson + 1 })
            } catch {
              // Not valid JSON: leave the text as it is.
            }
          }
        }
      }
    }
    match = BRACKET_PATTERN.exec(text)
  }

  // Build cleaned text by removing matched patterns (reverse order to preserve indices)
  let cleanedText = text
  for (let i = removals.length - 1; i >= 0; i--) {
    const { start, end } = removals[i]
    cleanedText = cleanedText.substring(0, start) + cleanedText.substring(end)
  }

  return { toolCalls, cleanedText }
}
