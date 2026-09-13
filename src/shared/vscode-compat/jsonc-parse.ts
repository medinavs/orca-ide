/**
 * Tolerant JSON reader for VS Code extension files.
 *
 * Needed because `language-configuration.json`, theme files and snippet files
 * are JSONC in practice: published extensions routinely contain `//` comments
 * and trailing commas, and `JSON.parse` rejects both. Without this, ordinary
 * extensions from the marketplace fail to load for a reason that looks like
 * corruption.
 *
 * The scanner is string-aware, which is the whole difficulty: a naive regex
 * strips the `//` inside `"url": "https://x"` and the `/*` inside a regex
 * pattern, producing valid-looking JSON with the wrong values.
 */

export type JsoncParseResult<T = unknown> = { ok: true; value: T } | { ok: false; error: string }

/** Removes comments and trailing commas without touching string contents. */
export function stripJsonComments(input: string): string {
  let output = ''
  let index = 0
  let inString = false
  let inLineComment = false
  let inBlockComment = false

  while (index < input.length) {
    const char = input[index]!
    const next = input[index + 1]

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false
        output += char
      }
      index += 1
      continue
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false
        index += 2
        continue
      }
      // Newlines are kept so reported error offsets stay on the right line.
      if (char === '\n') {
        output += char
      }
      index += 1
      continue
    }
    if (inString) {
      output += char
      if (char === '\\') {
        // Copy the escaped character verbatim: a trailing `\"` must not end
        // the string, and `\\` must not escape the following quote.
        const escaped = input[index + 1]
        if (escaped !== undefined) {
          output += escaped
          index += 2
          continue
        }
      }
      if (char === '"') {
        inString = false
      }
      index += 1
      continue
    }
    if (char === '"') {
      inString = true
      output += char
      index += 1
      continue
    }
    if (char === '/' && next === '/') {
      inLineComment = true
      index += 2
      continue
    }
    if (char === '/' && next === '*') {
      inBlockComment = true
      index += 2
      continue
    }
    output += char
    index += 1
  }

  return removeTrailingCommas(output)
}

/** Drops a comma that is followed only by whitespace and a closing bracket. */
function removeTrailingCommas(input: string): string {
  let output = ''
  let inString = false
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!
    if (inString) {
      output += char
      if (char === '\\') {
        const escaped = input[index + 1]
        if (escaped !== undefined) {
          output += escaped
          index += 1
        }
        continue
      }
      if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      output += char
      continue
    }
    if (char === ',') {
      let lookahead = index + 1
      while (lookahead < input.length && /\s/.test(input[lookahead]!)) {
        lookahead += 1
      }
      const following = input[lookahead]
      if (following === '}' || following === ']') {
        // Skip the comma; the whitespace is emitted by later iterations.
        continue
      }
    }
    output += char
  }
  return output
}

export function parseJsonc<T = unknown>(raw: string): JsoncParseResult<T> {
  try {
    return { ok: true, value: JSON.parse(stripJsonComments(raw)) as T }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
