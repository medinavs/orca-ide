/**
 * VS Code snippet files → Monaco snippet completions.
 *
 * The bodies need no translation: VS Code's snippet syntax *is* Monaco's
 * (`$1`, `${2:label}`, `$0`, `${1|a,b|}`), because Monaco is the editor VS Code
 * uses. So this module is about the file format around the bodies, and about
 * the two ways a snippet can go wrong:
 *
 * - a body given as an array of lines must be joined with `\n`, not rendered
 *   as `a,b,c`
 * - a body containing `$` that is *not* a placeholder (a shell snippet with
 *   `$PATH`, a PHP snippet with `$var`) would be read as a tab stop; those are
 *   detected and escaped so the snippet inserts what it says
 */

export type VscodeSnippet = {
  /** What the user types. May be several, and may be absent (name is used). */
  prefix?: string | string[]
  body?: string | string[]
  description?: string
  scope?: string
}

export type ParsedSnippet = {
  /** Trigger text. */
  prefix: string
  /** Snippet body in Monaco's syntax. */
  body: string
  /** Snippet name from the file's key. */
  name: string
  description?: string
  /** True when the body uses tab stops or placeholders. */
  hasTabStops: boolean
}

export type SnippetParseResult = {
  snippets: ParsedSnippet[]
  /** Entries that were skipped, with the reason, for the install report. */
  skipped: { name: string; reason: string }[]
}

/** Bounded so a hostile or generated snippet file cannot exhaust memory. */
export const SNIPPET_FILE_MAX_ENTRIES = 5_000
const SNIPPET_BODY_MAX_LENGTH = 32 * 1024

/**
 * A real tab stop: `$1`, `${1}`, `${1:default}`, `${1|a,b|}`, or `$0`.
 * Deliberately not `$PATH` or `${HOME}`, which are variables to a shell but
 * literal text to a snippet.
 */
const TAB_STOP_RE = /\$(\d+)|\$\{(\d+)(?::|\||\})/

/** VS Code snippet variables Monaco resolves on its own. */
const KNOWN_VARIABLE_RE =
  /\$\{?(TM_SELECTED_TEXT|TM_CURRENT_LINE|TM_CURRENT_WORD|TM_LINE_INDEX|TM_LINE_NUMBER|TM_FILENAME|TM_FILENAME_BASE|TM_DIRECTORY|TM_FILEPATH|RELATIVE_FILEPATH|CLIPBOARD|WORKSPACE_NAME|WORKSPACE_FOLDER|CURRENT_YEAR|CURRENT_YEAR_SHORT|CURRENT_MONTH|CURRENT_MONTH_NAME|CURRENT_MONTH_NAME_SHORT|CURRENT_DATE|CURRENT_DAY_NAME|CURRENT_DAY_NAME_SHORT|CURRENT_HOUR|CURRENT_MINUTE|CURRENT_SECOND|CURRENT_SECONDS_UNIX|CURRENT_TIMEZONE_OFFSET|RANDOM|RANDOM_HEX|UUID|BLOCK_COMMENT_START|BLOCK_COMMENT_END|LINE_COMMENT)\b\}?/

export function snippetHasTabStops(body: string): boolean {
  return TAB_STOP_RE.test(body)
}

/**
 * Escapes `$` sequences that are neither a tab stop nor a known variable.
 *
 * Without this, a shell snippet body of `echo $PATH` inserts `echo ` and jumps
 * the cursor, because Monaco reads `$P` as the start of a placeholder. Only
 * the ambiguous `$` are escaped — real tab stops must keep working.
 */
export function escapeNonPlaceholderDollars(body: string): string {
  return body.replace(/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/g, (match) =>
    KNOWN_VARIABLE_RE.test(match) ? match : `\\${match}`
  )
}

function normalizeBody(body: VscodeSnippet['body']): string | null {
  if (typeof body === 'string') {
    return body
  }
  if (Array.isArray(body)) {
    // Joined with newlines: rendering the array would insert commas.
    return body.filter((line) => typeof line === 'string').join('\n')
  }
  return null
}

function normalizePrefixes(prefix: VscodeSnippet['prefix'], name: string): string[] {
  if (typeof prefix === 'string' && prefix.trim() !== '') {
    return [prefix]
  }
  if (Array.isArray(prefix)) {
    const valid = prefix.filter((entry) => typeof entry === 'string' && entry.trim() !== '')
    if (valid.length > 0) {
      return valid
    }
  }
  // VS Code falls back to the snippet's key when no prefix is given.
  return name.trim() === '' ? [] : [name]
}

/**
 * Parses one snippet file. The file is a map of snippet name → definition.
 *
 * Malformed entries are skipped with a reason rather than failing the file: a
 * snippet pack with one bad entry should still contribute the other fifty.
 */
export function parseVscodeSnippetFile(raw: unknown): SnippetParseResult {
  const snippets: ParsedSnippet[] = []
  const skipped: { name: string; reason: string }[] = []
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { snippets, skipped: [{ name: '(file)', reason: 'not a JSON object' }] }
  }

  let seen = 0
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    seen += 1
    if (seen > SNIPPET_FILE_MAX_ENTRIES) {
      skipped.push({ name: '(remaining)', reason: `file exceeds ${SNIPPET_FILE_MAX_ENTRIES} snippets` })
      break
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      skipped.push({ name, reason: 'definition is not an object' })
      continue
    }
    const entry = value as VscodeSnippet
    const body = normalizeBody(entry.body)
    if (body === null || body === '') {
      skipped.push({ name, reason: 'no snippet body' })
      continue
    }
    if (body.length > SNIPPET_BODY_MAX_LENGTH) {
      skipped.push({ name, reason: 'snippet body is too large' })
      continue
    }
    const prefixes = normalizePrefixes(entry.prefix, name)
    if (prefixes.length === 0) {
      skipped.push({ name, reason: 'no prefix and no usable name' })
      continue
    }
    const hasTabStops = snippetHasTabStops(body)
    const safeBody = escapeNonPlaceholderDollars(body)
    for (const prefix of prefixes) {
      snippets.push({
        prefix,
        body: safeBody,
        name,
        description: typeof entry.description === 'string' ? entry.description : undefined,
        hasTabStops
      })
    }
  }
  return { snippets, skipped }
}

/** Monaco completion items for one language's snippets. */
export type SnippetCompletion = {
  label: string
  /** Monaco's `CompletionItemKind.Snippet`. */
  kind: 27
  insertText: string
  /** Monaco's `InsertAsSnippet`. */
  insertTextRules: 4
  detail: string
  documentation?: string
  sortText: string
}

export function toSnippetCompletions(snippets: readonly ParsedSnippet[]): SnippetCompletion[] {
  return snippets.map((snippet) => ({
    label: snippet.prefix,
    kind: 27,
    insertText: snippet.body,
    insertTextRules: 4,
    detail: snippet.name,
    documentation: snippet.description,
    // Sorted after real language completions: a snippet suggestion outranking
    // an actual symbol is the most common complaint about snippet packs.
    sortText: `zz${snippet.prefix}`
  }))
}
