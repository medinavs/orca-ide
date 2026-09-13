/**
 * Extension snippets as Monaco completion providers, one per language.
 *
 * A single provider per language holding a mutable snippet list, rather than
 * one provider per extension: Monaco has no way to remove a provider, so
 * registering per extension would leave a dead provider behind every time an
 * extension was disabled. Here, disabling swaps the list and the suggestions
 * disappear immediately.
 */
import type * as Monaco from 'monaco-editor'
import {
  toSnippetCompletions,
  type ParsedSnippet
} from '../../../../shared/vscode-compat/vscode-snippets'

type MonacoModule = typeof Monaco

/** Language id → the snippets currently contributed for it. */
const snippetsByLanguage = new Map<string, ParsedSnippet[]>()
const providerRegistered = new Set<string>()

export type ExtensionSnippetContribution = {
  extensionId: string
  languageId: string
  snippets: ParsedSnippet[]
}

/**
 * Replaces the snippet set for every language in `contributions` and registers
 * a provider for any language that does not have one yet.
 *
 * Returns the number of languages that now have snippets.
 */
export function registerExtensionSnippets(
  monaco: MonacoModule,
  contributions: readonly ExtensionSnippetContribution[]
): number {
  // Rebuilt wholesale so a removed extension's snippets actually disappear
  // rather than lingering from a previous call.
  const next = new Map<string, ParsedSnippet[]>()
  for (const contribution of contributions) {
    const existing = next.get(contribution.languageId)
    if (existing) {
      existing.push(...contribution.snippets)
      continue
    }
    next.set(contribution.languageId, [...contribution.snippets])
  }
  snippetsByLanguage.clear()
  for (const [languageId, snippets] of next) {
    snippetsByLanguage.set(languageId, snippets)
  }

  for (const languageId of snippetsByLanguage.keys()) {
    if (providerRegistered.has(languageId)) {
      continue
    }
    providerRegistered.add(languageId)
    monaco.languages.registerCompletionItemProvider(languageId, {
      provideCompletionItems: (model, position) => {
        const snippets = snippetsByLanguage.get(languageId) ?? []
        if (snippets.length === 0) {
          return { suggestions: [] }
        }
        // Replacing the partially typed word, so accepting a snippet does not
        // leave the prefix behind in front of it.
        const word = model.getWordUntilPosition(position)
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn
        }
        return {
          suggestions: toSnippetCompletions(snippets).map((completion) => ({
            ...completion,
            range
          })) as unknown as Monaco.languages.CompletionItem[]
        }
      }
    })
  }
  return snippetsByLanguage.size
}

export function extensionSnippetsFor(languageId: string): ParsedSnippet[] {
  return snippetsByLanguage.get(languageId) ?? []
}

export function resetExtensionSnippetsForTests(): void {
  snippetsByLanguage.clear()
  providerRegistered.clear()
}
