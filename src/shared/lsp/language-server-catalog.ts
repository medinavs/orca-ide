/**
 * Which language server serves which language, as data. The LSP runtime reads
 * this table and knows nothing about any particular language; adding one is a
 * catalog entry plus (optionally) a Monaco language registration.
 *
 * `command` is a bare program name on purpose — resolution against the
 * execution host's PATH happens at spawn time, because the same catalog is
 * read by clients that are not the host that will run it.
 */

export type LanguageServerSpec = {
  /** Stable key; also the settings key that overrides this entry. */
  id: string
  /** Shown in setup messages and the Problems source column. */
  label: string
  /** Monaco language ids this server serves. */
  languageIds: readonly string[]
  command: string
  args: readonly string[]
  /** Told to the user verbatim when `command` is not on PATH. */
  installHint: string
  documentationUrl?: string
  initializationOptions?: Record<string, unknown>
}

export const LANGUAGE_SERVER_CATALOG: readonly LanguageServerSpec[] = [
  {
    id: 'gopls',
    label: 'gopls',
    languageIds: ['go'],
    command: 'gopls',
    args: [],
    installHint: 'Install with: go install golang.org/x/tools/gopls@latest',
    documentationUrl: 'https://pkg.go.dev/golang.org/x/tools/gopls',
    // Why: gopls reports unused parameters and shadowed variables only when
    // asked; both are what a Go author expects an IDE to point out.
    initializationOptions: { staticcheck: false, analyses: { unusedparams: true } }
  },
  {
    id: 'typescript',
    label: 'TypeScript / JavaScript',
    languageIds: ['typescript', 'javascript'],
    command: 'typescript-language-server',
    args: ['--stdio'],
    installHint:
      'Install TypeScript 7+: npm i -g typescript. For TypeScript 6 and earlier: npm i -g typescript-language-server typescript@6',
    documentationUrl: 'https://github.com/typescript-language-server/typescript-language-server'
  },
  {
    id: 'pyright',
    label: 'pyright',
    languageIds: ['python'],
    command: 'pyright-langserver',
    args: ['--stdio'],
    installHint: 'Install with: npm i -g pyright',
    documentationUrl: 'https://microsoft.github.io/pyright/'
  },
  {
    id: 'rust-analyzer',
    label: 'rust-analyzer',
    languageIds: ['rust'],
    command: 'rust-analyzer',
    args: [],
    installHint: 'Install with: rustup component add rust-analyzer',
    documentationUrl: 'https://rust-analyzer.github.io/'
  }
]

/** User overrides, keyed by catalog id. An unknown key adds a server. */
export type LanguageServerOverride = {
  /** Full argv; `[]` or omitted keeps the catalog command. */
  command?: readonly string[]
  languageIds?: readonly string[]
  enabled?: boolean
  initializationOptions?: Record<string, unknown>
}

export type LanguageServerOverrides = Readonly<Record<string, LanguageServerOverride>>

function applyOverride(
  spec: LanguageServerSpec,
  override: LanguageServerOverride
): LanguageServerSpec {
  const [program, ...args] = override.command ?? []
  return {
    ...spec,
    command: program ?? spec.command,
    args: program === undefined ? spec.args : args,
    languageIds: override.languageIds ?? spec.languageIds,
    initializationOptions: override.initializationOptions ?? spec.initializationOptions
  }
}

/** The effective server table: catalog entries overridden, plus user additions. */
export function resolveLanguageServers(
  overrides: LanguageServerOverrides = {}
): LanguageServerSpec[] {
  const resolved: LanguageServerSpec[] = []
  for (const spec of LANGUAGE_SERVER_CATALOG) {
    const override = overrides[spec.id]
    if (override?.enabled === false) {
      continue
    }
    resolved.push(override ? applyOverride(spec, override) : spec)
  }
  for (const [id, override] of Object.entries(overrides)) {
    if (LANGUAGE_SERVER_CATALOG.some((spec) => spec.id === id) || override.enabled === false) {
      continue
    }
    const [program, ...args] = override.command ?? []
    if (program === undefined || override.languageIds === undefined) {
      // A user-defined server needs both halves; a partial entry is ignored
      // rather than guessed at, so a typo cannot shadow a catalog server.
      continue
    }
    resolved.push({
      id,
      label: id,
      languageIds: override.languageIds,
      command: program,
      args,
      installHint: `Install ${program} and make sure it is on PATH.`,
      initializationOptions: override.initializationOptions
    })
  }
  return resolved
}

/** First server serving `languageId`, or null when the language has none. */
export function languageServerForLanguage(
  languageId: string,
  overrides: LanguageServerOverrides = {}
): LanguageServerSpec | null {
  return (
    resolveLanguageServers(overrides).find((spec) => spec.languageIds.includes(languageId)) ?? null
  )
}
