/**
 * Registers enabled extension contributions into Monaco.
 *
 *   contributions (IPC) → this → monaco.languages / monaco.editor.defineTheme
 *
 * Registration is additive and idempotent: Monaco has no "unregister a
 * language" API, so disabling an extension takes effect on the next reload for
 * languages and grammars, while themes and snippets — which are looked up at
 * use time — take effect immediately. That asymmetry is real and is documented
 * rather than hidden behind a fake teardown.
 *
 * Grammars reuse Orca's existing TextMate tokenizer
 * (`textmate-token-provider.ts`) — the same one the bundled Nim grammar uses —
 * so an extension grammar and a built-in one tokenize identically. Only the
 * registration differs; see `attachTextMateTokensProvider` for why.
 */
import type * as Monaco from 'monaco-editor'
import type { VscodeContributionBundle } from '../../../../main/vscode-compat/vscode-extension-service'
import type { IRawGrammar } from 'vscode-textmate'
import type { MonacoLanguageConfiguration } from '../../../../shared/vscode-compat/vscode-language-configuration'
import type { createTextMateTokensProvider } from '../monaco-languages/textmate-token-provider'
import { registerExtensionSnippets } from './extension-snippet-provider'

type MonacoModule = typeof Monaco
type TextMateProviderModule = {
  createTextMateTokensProvider: typeof createTextMateTokensProvider
}

const registeredLanguages = new Set<string>()
const registeredThemes = new Set<string>()
const registeredGrammarScopes = new Set<string>()

export type ExtensionRegistrationSummary = {
  languages: number
  themes: number
  grammars: number
  snippetLanguages: number
  /** Problems worth showing next to the extension in the list. */
  problems: string[]
}

/** Fetches a grammar body over IPC when its language is first tokenized. */
async function loadGrammarBody(extensionId: string, scopeName: string): Promise<IRawGrammar> {
  const api = window.api?.vscodeExtensions
  if (!api) {
    throw new Error('extension bridge unavailable')
  }
  const result = await api.readGrammar({ extensionId, scopeName })
  if (!result.ok) {
    throw new Error(result.error)
  }
  return JSON.parse(result.contents) as IRawGrammar
}

/**
 * Attaches a lazily-built TextMate tokenizer to an already-registered
 * language, mirroring what `registerTextMateLanguage` does for a new one.
 *
 * `registerTokensProviderFactory` is used rather than `setTokensProvider`
 * because plain tokenization requests go through the factory: `onLanguage`
 * only fires for rich features, so an eagerly-set provider never loads for a
 * file the user merely reads.
 */
function attachTextMateTokensProvider(
  monaco: MonacoModule,
  languageId: string,
  scopeName: string,
  loadGrammar: () => Promise<IRawGrammar>,
  // Injectable for the same reason `textmate-language-registration.ts` makes
  // it injectable: the real module pulls in the Oniguruma wasm engine, which a
  // unit test has no way to serve.
  loadProviderModule: () => Promise<TextMateProviderModule> = () =>
    import('../monaco-languages/textmate-token-provider')
): void {
  let providerPromise: Promise<Monaco.languages.TokensProvider> | undefined
  monaco.languages.registerTokensProviderFactory(languageId, {
    create: () => {
      providerPromise ??= loadProviderModule().then(({ createTextMateTokensProvider }) =>
        createTextMateTokensProvider({ scopeName, loadGrammar })
      )
      return providerPromise
    }
  })
}

export type RegisterContributionsOptions = {
  /** Test seam; see `attachTextMateTokensProvider`. */
  loadProviderModule?: () => Promise<TextMateProviderModule>
}

export function registerVscodeContributions(
  monaco: MonacoModule,
  bundle: VscodeContributionBundle,
  options: RegisterContributionsOptions = {}
): ExtensionRegistrationSummary {
  const problems: string[] = []
  let languages = 0
  let themes = 0
  let grammars = 0

  for (const theme of bundle.themes) {
    if (registeredThemes.has(theme.id)) {
      continue
    }
    try {
      monaco.editor.defineTheme(theme.id, theme.data as Monaco.editor.IStandaloneThemeData)
      registeredThemes.add(theme.id)
      themes += 1
    } catch (error) {
      // One malformed theme must not stop the others from registering.
      problems.push(`Theme "${theme.label}" was rejected by the editor: ${String(error)}`)
    }
  }

  // Languages before grammars: a grammar's `language` must already exist or
  // its tokenizer is attached to nothing.
  for (const language of bundle.languages) {
    if (registeredLanguages.has(language.id)) {
      continue
    }
    const alreadyKnown = monaco.languages
      .getLanguages()
      .some((known) => known.id === language.id)
    if (!alreadyKnown) {
      monaco.languages.register({
        id: language.id,
        extensions: language.extensions,
        aliases: language.aliases,
        filenames: language.filenames
      })
      languages += 1
    }
    if (language.configuration) {
      monaco.languages.setLanguageConfiguration(
        language.id,
        language.configuration as unknown as Monaco.languages.LanguageConfiguration
      )
    }
    registeredLanguages.add(language.id)
  }

  for (const grammar of bundle.grammars) {
    if (grammar.languageId === undefined || registeredGrammarScopes.has(grammar.scopeName)) {
      // A grammar with no `language` is an injection-only grammar; Orca has no
      // injection support, so attaching it to nothing would be misleading.
      continue
    }
    // The tokens provider is attached directly rather than through
    // `registerTextMateLanguage`, which registers the language *and* its
    // tokenizer together and early-returns when the language already exists.
    // Every grammar here targets a language that is already registered —
    // either just above, or built into Monaco — so that helper would always
    // bail out and silently leave the grammar unattached.
    attachTextMateTokensProvider(
      monaco,
      grammar.languageId,
      grammar.scopeName,
      () => loadGrammarBody(grammar.extensionId, grammar.scopeName),
      options.loadProviderModule
    )
    registeredGrammarScopes.add(grammar.scopeName)
    grammars += 1
  }

  const snippetLanguages = registerExtensionSnippets(monaco, bundle.snippets)

  return { languages, themes, grammars, snippetLanguages, problems }
}

/** Theme ids currently defined in Monaco, for the theme picker. */
export function registeredExtensionThemeIds(): string[] {
  return [...registeredThemes]
}

export function resetVscodeContributionRegistrationForTests(): void {
  registeredLanguages.clear()
  registeredThemes.clear()
  registeredGrammarScopes.clear()
}

export type { MonacoLanguageConfiguration }
