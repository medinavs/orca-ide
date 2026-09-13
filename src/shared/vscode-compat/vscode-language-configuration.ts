/**
 * VS Code `language-configuration.json` → Monaco `LanguageConfiguration`.
 *
 * This is what gives a contributed language working comment toggling, bracket
 * matching, auto-closing quotes and indentation — the "language-aware editing"
 * half of language support, independent of any server.
 *
 * The shapes are close but not identical, and the differences are the content
 * of this module:
 *
 * - VS Code writes regexes as `{ pattern, flags }` objects *or* as strings;
 *   Monaco wants a real `RegExp`. An invalid pattern from an extension must not
 *   throw during registration, so each one is compiled defensively.
 * - `brackets` entries are `[open, close]` tuples in the file and
 *   `{ open, close }` objects in Monaco.
 */

export type VscodeRegexSource = string | { pattern?: string; flags?: string }

export type VscodeLanguageConfigurationDocument = {
  comments?: { lineComment?: string; blockComment?: [string, string] | string[] }
  brackets?: (string[] | { open?: string; close?: string })[]
  autoClosingPairs?: (string[] | { open?: string; close?: string; notIn?: string[] })[]
  surroundingPairs?: (string[] | { open?: string; close?: string })[]
  wordPattern?: VscodeRegexSource
  folding?: {
    offSide?: boolean
    markers?: { start?: VscodeRegexSource; end?: VscodeRegexSource }
  }
  indentationRules?: {
    increaseIndentPattern?: VscodeRegexSource
    decreaseIndentPattern?: VscodeRegexSource
    indentNextLinePattern?: VscodeRegexSource
    unIndentedLinePattern?: VscodeRegexSource
  }
  onEnterRules?: unknown[]
  autoCloseBefore?: string
}

export type MonacoPair = { open: string; close: string }

export type MonacoLanguageConfiguration = {
  comments?: { lineComment?: string; blockComment?: [string, string] }
  brackets?: [string, string][]
  autoClosingPairs?: { open: string; close: string; notIn?: string[] }[]
  surroundingPairs?: MonacoPair[]
  wordPattern?: RegExp
  folding?: { offSide?: boolean; markers?: { start: RegExp; end: RegExp } }
  indentationRules?: {
    increaseIndentPattern: RegExp
    decreaseIndentPattern: RegExp
    indentNextLinePattern?: RegExp
    unIndentedLinePattern?: RegExp
  }
  autoCloseBefore?: string
}

export type LanguageConfigurationAdaptResult = {
  configuration: MonacoLanguageConfiguration
  /** Patterns that would not compile, named for the install report. */
  invalidPatterns: string[]
}

/** Guards against a catastrophic pattern from an untrusted extension. */
const MAX_PATTERN_LENGTH = 1024

function toRegExp(
  source: VscodeRegexSource | undefined,
  label: string,
  invalid: string[]
): RegExp | undefined {
  if (source === undefined) {
    return undefined
  }
  const pattern = typeof source === 'string' ? source : source.pattern
  const flags = typeof source === 'string' ? undefined : source.flags
  if (typeof pattern !== 'string' || pattern === '' || pattern.length > MAX_PATTERN_LENGTH) {
    invalid.push(label)
    return undefined
  }
  try {
    return new RegExp(pattern, flags)
  } catch {
    // An extension's bad regex must not throw while registering a language.
    invalid.push(label)
    return undefined
  }
}

function toPair(
  entry: string[] | { open?: string; close?: string } | undefined
): MonacoPair | null {
  if (Array.isArray(entry)) {
    const [open, close] = entry
    return typeof open === 'string' && typeof close === 'string' ? { open, close } : null
  }
  if (entry && typeof entry.open === 'string' && typeof entry.close === 'string') {
    return { open: entry.open, close: entry.close }
  }
  return null
}

export function adaptVscodeLanguageConfiguration(
  raw: unknown
): LanguageConfigurationAdaptResult {
  const invalidPatterns: string[] = []
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { configuration: {}, invalidPatterns: ['(file is not a JSON object)'] }
  }
  const document = raw as VscodeLanguageConfigurationDocument
  const configuration: MonacoLanguageConfiguration = {}

  if (document.comments) {
    const blockComment = document.comments.blockComment
    const block =
      Array.isArray(blockComment) &&
      typeof blockComment[0] === 'string' &&
      typeof blockComment[1] === 'string'
        ? ([blockComment[0], blockComment[1]] as [string, string])
        : undefined
    configuration.comments = {
      ...(typeof document.comments.lineComment === 'string'
        ? { lineComment: document.comments.lineComment }
        : {}),
      ...(block ? { blockComment: block } : {})
    }
  }

  const brackets = (document.brackets ?? [])
    .map((entry) => toPair(entry))
    .filter((pair): pair is MonacoPair => pair !== null)
    // Monaco takes tuples here, unlike the pair objects it takes elsewhere.
    .map((pair) => [pair.open, pair.close] as [string, string])
  if (brackets.length > 0) {
    configuration.brackets = brackets
  }

  const autoClosing = (document.autoClosingPairs ?? [])
    .map((entry) => {
      const pair = toPair(entry)
      if (pair === null) {
        return null
      }
      const notIn =
        !Array.isArray(entry) && Array.isArray(entry.notIn)
          ? entry.notIn.filter((scope): scope is string => typeof scope === 'string')
          : undefined
      return { ...pair, ...(notIn && notIn.length > 0 ? { notIn } : {}) }
    })
    .filter((pair): pair is { open: string; close: string; notIn?: string[] } => pair !== null)
  if (autoClosing.length > 0) {
    configuration.autoClosingPairs = autoClosing
  }

  const surrounding = (document.surroundingPairs ?? [])
    .map((entry) => toPair(entry))
    .filter((pair): pair is MonacoPair => pair !== null)
  if (surrounding.length > 0) {
    configuration.surroundingPairs = surrounding
  }

  const wordPattern = toRegExp(document.wordPattern, 'wordPattern', invalidPatterns)
  if (wordPattern) {
    configuration.wordPattern = wordPattern
  }

  if (document.folding) {
    const start = toRegExp(document.folding.markers?.start, 'folding.markers.start', invalidPatterns)
    const end = toRegExp(document.folding.markers?.end, 'folding.markers.end', invalidPatterns)
    configuration.folding = {
      ...(typeof document.folding.offSide === 'boolean'
        ? { offSide: document.folding.offSide }
        : {}),
      // Monaco needs both markers or neither; one alone folds nothing.
      ...(start && end ? { markers: { start, end } } : {})
    }
  }

  const rules = document.indentationRules
  if (rules) {
    const increase = toRegExp(
      rules.increaseIndentPattern,
      'indentationRules.increaseIndentPattern',
      invalidPatterns
    )
    const decrease = toRegExp(
      rules.decreaseIndentPattern,
      'indentationRules.decreaseIndentPattern',
      invalidPatterns
    )
    const indentNext = toRegExp(
      rules.indentNextLinePattern,
      'indentationRules.indentNextLinePattern',
      invalidPatterns
    )
    const unIndented = toRegExp(
      rules.unIndentedLinePattern,
      'indentationRules.unIndentedLinePattern',
      invalidPatterns
    )
    // Both of the first two are required by Monaco; a half-specified rule is
    // dropped rather than completed with a guess, which would reindent the
    // user's code wrongly.
    if (increase && decrease) {
      configuration.indentationRules = {
        increaseIndentPattern: increase,
        decreaseIndentPattern: decrease,
        ...(indentNext ? { indentNextLinePattern: indentNext } : {}),
        ...(unIndented ? { unIndentedLinePattern: unIndented } : {})
      }
    }
  }

  if (typeof document.autoCloseBefore === 'string') {
    configuration.autoCloseBefore = document.autoCloseBefore
  }

  return { configuration, invalidPatterns }
}
