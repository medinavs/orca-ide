/**
 * Registers Monaco's language-feature providers against the LSP bridge.
 *
 * Registered lazily, once per language, the first time a document of that
 * language is bound to a server: the set of languages with servers is not
 * known up front (a settings override can add one), and registering providers
 * for a language nobody opens costs the editor a provider lookup on every
 * keystroke for nothing.
 *
 * Every provider answers `null`/empty on an unavailable or unsupported result
 * rather than throwing. A missing feature should look like a feature the
 * server does not have, not like a broken editor.
 */
import type { editor, languages, Position, CancellationToken, IRange } from 'monaco-editor'
import type {
  LspCodeAction,
  LspCompletionItem,
  LspCompletionList,
  LspDocumentSymbol,
  LspHover,
  LspSymbolInformation,
  LspTextEdit
} from '../../../../shared/lsp/lsp-protocol-types'
import type { LanguageFeatureResult } from '../../../../preload/api/language-server-api'
import {
  toMonacoCodeActions,
  toMonacoCompletionList,
  toMonacoDocumentSymbols,
  toMonacoHover,
  toMonacoLocations,
  toMonacoTextEdits,
  type AnnotatedLocation
} from './lsp-feature-conversion'
import { lspDocumentForModel } from './lsp-document-registry'

type MonacoModule = {
  languages: Pick<
    typeof languages,
    | 'registerHoverProvider'
    | 'registerCompletionItemProvider'
    | 'registerDefinitionProvider'
    | 'registerReferenceProvider'
    | 'registerDocumentSymbolProvider'
    | 'registerDocumentFormattingEditProvider'
    | 'registerCodeActionProvider'
  >
  Uri: { parse: (value: string) => { toString: () => string } }
  Range: new (a: number, b: number, c: number, d: number) => IRange
}

const registeredLanguages = new Set<string>()

/** Monaco positions are 1-based; LSP's are 0-based. */
function toLspPosition(position: Position): { line: number; character: number } {
  return { line: position.lineNumber - 1, character: position.column - 1 }
}

async function request<T>(
  model: editor.ITextModel,
  method: string,
  params?: unknown
): Promise<T | null> {
  const ref = lspDocumentForModel(model)
  const api = window.api?.languageServers
  if (ref === null || !api) {
    return null
  }
  try {
    const answer: LanguageFeatureResult<T> = await api.request<T>(ref, method, params)
    return answer.ok ? answer.result : null
  } catch {
    // A rejected bridge call (main restarting, window closing) is not
    // something the editor should surface mid-keystroke.
    return null
  }
}

export function registerLspProvidersForLanguage(
  monaco: MonacoModule,
  languageId: string
): void {
  if (registeredLanguages.has(languageId)) {
    return
  }
  registeredLanguages.add(languageId)

  monaco.languages.registerHoverProvider(languageId, {
    provideHover: async (model, position) => {
      const hover = await request<LspHover>(model, 'textDocument/hover', {
        position: toLspPosition(position)
      })
      return toMonacoHover(hover) ?? undefined
    }
  })

  monaco.languages.registerCompletionItemProvider(languageId, {
    // The set servers most commonly declare; Monaco also triggers on word
    // characters by default, so this only adds the punctuation cases.
    triggerCharacters: ['.', ':', '>', '"', "'", '/', '@', '<'],
    provideCompletionItems: async (model, position) => {
      const word = model.getWordUntilPosition(position)
      const fallback = {
        start: { line: position.lineNumber - 1, character: word.startColumn - 1 },
        end: { line: position.lineNumber - 1, character: word.endColumn - 1 }
      }
      const result = await request<LspCompletionList | LspCompletionItem[]>(
        model,
        'textDocument/completion',
        { position: toLspPosition(position), context: { triggerKind: 1 } }
      )
      const converted = toMonacoCompletionList(result, fallback)
      return {
        suggestions: converted.suggestions as unknown as languages.CompletionItem[],
        incomplete: converted.incomplete
      }
    }
  })

  monaco.languages.registerDefinitionProvider(languageId, {
    provideDefinition: async (model, position) => {
      const result = await request<AnnotatedLocation | AnnotatedLocation[]>(
        model,
        'textDocument/definition',
        { position: toLspPosition(position) }
      )
      return toMonacoLocations(result).map((location) => ({
        uri: monaco.Uri.parse(location.uri),
        range: location.range
      })) as unknown as languages.Definition
    }
  })

  monaco.languages.registerReferenceProvider(languageId, {
    provideReferences: async (model, position, context) => {
      const result = await request<AnnotatedLocation[]>(model, 'textDocument/references', {
        position: toLspPosition(position),
        context: { includeDeclaration: context.includeDeclaration }
      })
      return toMonacoLocations(result).map((location) => ({
        uri: monaco.Uri.parse(location.uri),
        range: location.range
      })) as unknown as languages.Location[]
    }
  })

  monaco.languages.registerDocumentSymbolProvider(languageId, {
    provideDocumentSymbols: async (model) => {
      const result = await request<(LspDocumentSymbol | LspSymbolInformation)[]>(
        model,
        'textDocument/documentSymbol'
      )
      return toMonacoDocumentSymbols(result) as unknown as languages.DocumentSymbol[]
    }
  })

  monaco.languages.registerDocumentFormattingEditProvider(languageId, {
    provideDocumentFormattingEdits: async (model, options) => {
      const result = await request<LspTextEdit[]>(model, 'textDocument/formatting', {
        options: {
          tabSize: options.tabSize,
          insertSpaces: options.insertSpaces,
          trimTrailingWhitespace: true,
          insertFinalNewline: true
        }
      })
      return toMonacoTextEdits(result) as unknown as languages.TextEdit[]
    }
  })

  monaco.languages.registerCodeActionProvider(languageId, {
    provideCodeActions: async (model, range, context) => {
      const result = await request<LspCodeAction[]>(model, 'textDocument/codeAction', {
        range: {
          start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
          end: { line: range.endLineNumber - 1, character: range.endColumn - 1 }
        },
        context: {
          diagnostics: [],
          only: context.only === undefined ? undefined : [context.only]
        }
      })
      const actions = toMonacoCodeActions(result)
        // An action whose only effect is a server command is dropped rather
        // than listed: Orca cannot run it, and a lightbulb entry that does
        // nothing is worse than one fewer entry.
        .filter((action) => action.unsupportedCommand === undefined)
        .map((action) => ({
          title: action.title,
          kind: action.kind,
          isPreferred: action.isPreferred,
          edit:
            action.edit === undefined
              ? undefined
              : {
                  edits: action.edit.edits.map((entry) => ({
                    resource: monaco.Uri.parse(entry.resource),
                    textEdit: entry.textEdit,
                    versionId: undefined
                  }))
                }
        }))
      return {
        actions: actions as unknown as languages.CodeAction[],
        dispose: () => {}
      }
    }
  })
}

/** Test seam: forgets which languages have providers. */
export function resetLspProviderRegistrationForTests(): void {
  registeredLanguages.clear()
}

export function registeredLspLanguages(): string[] {
  return [...registeredLanguages]
}

export type { CancellationToken }
