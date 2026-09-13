import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { editor } from 'monaco-editor'
import type { LanguageDocumentRef } from '../../../../preload/api/language-server-api'
import {
  clearLspDocumentRegistry,
  registerLspDocument
} from './lsp-document-registry'
import {
  registeredLspLanguages,
  registerLspProvidersForLanguage,
  resetLspProviderRegistrationForTests
} from './register-lsp-providers'

const REF: LanguageDocumentRef = {
  executionHostId: 'local',
  rootPath: '/repo',
  path: '/repo/main.go',
  languageId: 'go'
}

type CapturedProviders = {
  hover?: { provideHover: (model: unknown, position: unknown) => Promise<unknown> }
  completion?: {
    triggerCharacters?: string[]
    provideCompletionItems: (model: unknown, position: unknown) => Promise<unknown>
  }
  definition?: { provideDefinition: (model: unknown, position: unknown) => Promise<unknown> }
  references?: {
    provideReferences: (model: unknown, position: unknown, context: unknown) => Promise<unknown>
  }
  symbols?: { provideDocumentSymbols: (model: unknown) => Promise<unknown> }
  formatting?: {
    provideDocumentFormattingEdits: (model: unknown, options: unknown) => Promise<unknown>
  }
  codeActions?: {
    provideCodeActions: (model: unknown, range: unknown, context: unknown) => Promise<unknown>
  }
}

let captured: CapturedProviders
let registeredFor: string[]
let requestSpy: ReturnType<typeof vi.fn>

function fakeMonaco(): Parameters<typeof registerLspProvidersForLanguage>[0] {
  return {
    languages: {
      registerHoverProvider: (language: string, provider: unknown) => {
        registeredFor.push(language)
        captured.hover = provider as CapturedProviders['hover']
        return { dispose: () => {} }
      },
      registerCompletionItemProvider: (_language: string, provider: unknown) => {
        captured.completion = provider as CapturedProviders['completion']
        return { dispose: () => {} }
      },
      registerDefinitionProvider: (_language: string, provider: unknown) => {
        captured.definition = provider as CapturedProviders['definition']
        return { dispose: () => {} }
      },
      registerReferenceProvider: (_language: string, provider: unknown) => {
        captured.references = provider as CapturedProviders['references']
        return { dispose: () => {} }
      },
      registerDocumentSymbolProvider: (_language: string, provider: unknown) => {
        captured.symbols = provider as CapturedProviders['symbols']
        return { dispose: () => {} }
      },
      registerDocumentFormattingEditProvider: (_language: string, provider: unknown) => {
        captured.formatting = provider as CapturedProviders['formatting']
        return { dispose: () => {} }
      },
      registerCodeActionProvider: (_language: string, provider: unknown) => {
        captured.codeActions = provider as CapturedProviders['codeActions']
        return { dispose: () => {} }
      }
    },
    Uri: { parse: (value: string) => ({ toString: () => value }) },
    Range: class {
      constructor(
        public startLineNumber: number,
        public startColumn: number,
        public endLineNumber: number,
        public endColumn: number
      ) {}
    }
  } as unknown as Parameters<typeof registerLspProvidersForLanguage>[0]
}

function fakeModel(): editor.ITextModel {
  return {
    uri: { toString: () => 'file:///repo/main.go' },
    getWordUntilPosition: () => ({ startColumn: 3, endColumn: 8, word: 'Prin' })
  } as unknown as editor.ITextModel
}

const POSITION = { lineNumber: 12, column: 5 }

beforeEach(() => {
  captured = {}
  registeredFor = []
  requestSpy = vi.fn(async () => ({ ok: true, result: null }))
  ;(globalThis as { window?: unknown }).window = {
    api: { languageServers: { request: requestSpy } }
  }
  resetLspProviderRegistrationForTests()
  clearLspDocumentRegistry()
  registerLspDocument(fakeModel(), REF)
  registerLspProvidersForLanguage(fakeMonaco(), 'go')
})

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

describe('registerLspProvidersForLanguage', () => {
  it('registers every provider Orca supports', () => {
    expect(Object.keys(captured).sort()).toEqual([
      'codeActions',
      'completion',
      'definition',
      'formatting',
      'hover',
      'references',
      'symbols'
    ])
  })

  it('registers a language only once', () => {
    registerLspProvidersForLanguage(fakeMonaco(), 'go')
    expect(registeredFor).toEqual(['go'])
    expect(registeredLspLanguages()).toEqual(['go'])
  })

  it('registers a second language separately', () => {
    registerLspProvidersForLanguage(fakeMonaco(), 'python')
    expect(registeredLspLanguages().sort()).toEqual(['go', 'python'])
  })

  it('declares punctuation trigger characters for completion', () => {
    expect(captured.completion?.triggerCharacters).toContain('.')
  })
})

describe('provider requests', () => {
  it('converts the Monaco position to 0-based for hover', async () => {
    await captured.hover?.provideHover(fakeModel(), POSITION)
    expect(requestSpy).toHaveBeenCalledWith(REF, 'textDocument/hover', {
      position: { line: 11, character: 4 }
    })
  })

  it('passes includeDeclaration through for references', async () => {
    await captured.references?.provideReferences(fakeModel(), POSITION, {
      includeDeclaration: false
    })
    expect(requestSpy).toHaveBeenCalledWith(REF, 'textDocument/references', {
      position: { line: 11, character: 4 },
      context: { includeDeclaration: false }
    })
  })

  it('sends formatting options from the editor', async () => {
    await captured.formatting?.provideDocumentFormattingEdits(fakeModel(), {
      tabSize: 4,
      insertSpaces: false
    })
    expect(requestSpy).toHaveBeenCalledWith(
      REF,
      'textDocument/formatting',
      expect.objectContaining({ options: expect.objectContaining({ tabSize: 4 }) })
    )
  })

  it('converts a code-action range to 0-based', async () => {
    await captured.codeActions?.provideCodeActions(
      fakeModel(),
      { startLineNumber: 3, startColumn: 2, endLineNumber: 3, endColumn: 9 },
      {}
    )
    expect(requestSpy).toHaveBeenCalledWith(
      REF,
      'textDocument/codeAction',
      expect.objectContaining({
        range: {
          start: { line: 2, character: 1 },
          end: { line: 2, character: 8 }
        }
      })
    )
  })

  it('returns hover content when the server answers', async () => {
    requestSpy.mockResolvedValueOnce({
      ok: true,
      result: { contents: { kind: 'markdown', value: 'func Greet' } }
    })
    const hover = await captured.hover?.provideHover(fakeModel(), POSITION)
    expect(hover).toMatchObject({ contents: [{ value: 'func Greet' }] })
  })

  it('converts definitions into Monaco locations', async () => {
    requestSpy.mockResolvedValueOnce({
      ok: true,
      result: {
        uri: 'file:///repo/main.go',
        range: { start: { line: 4, character: 5 }, end: { line: 4, character: 10 } }
      }
    })
    const definitions = (await captured.definition?.provideDefinition(
      fakeModel(),
      POSITION
    )) as { range: { startLineNumber: number } }[]
    expect(definitions[0]!.range.startLineNumber).toBe(5)
  })

  it('drops a code action Orca cannot perform', async () => {
    requestSpy.mockResolvedValueOnce({
      ok: true,
      result: [
        { title: 'Run tidy', command: { title: 't', command: 'gopls.tidy' } },
        {
          title: 'Organize imports',
          edit: {
            changes: {
              'file:///repo/main.go': [
                {
                  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                  newText: ''
                }
              ]
            }
          }
        }
      ]
    })
    const answer = (await captured.codeActions?.provideCodeActions(
      fakeModel(),
      { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
      {}
    )) as { actions: { title: string }[] }
    // A lightbulb entry that silently does nothing is worse than one fewer.
    expect(answer.actions.map((action) => action.title)).toEqual(['Organize imports'])
  })
})

describe('provider degradation', () => {
  it('answers nothing for a model with no bound document', async () => {
    clearLspDocumentRegistry()
    const hover = await captured.hover?.provideHover(fakeModel(), POSITION)
    expect(hover).toBeUndefined()
    expect(requestSpy).not.toHaveBeenCalled()
  })

  it('answers nothing when the feature is unsupported', async () => {
    requestSpy.mockResolvedValueOnce({ ok: false, reason: 'unsupported', message: 'no hover' })
    // Must look like "this server has no hover", not like a broken editor.
    expect(await captured.hover?.provideHover(fakeModel(), POSITION)).toBeUndefined()
  })

  it('answers nothing when the bridge rejects', async () => {
    requestSpy.mockRejectedValueOnce(new Error('main is restarting'))
    expect(await captured.hover?.provideHover(fakeModel(), POSITION)).toBeUndefined()
  })

  it('returns empty collections rather than null for list features', async () => {
    requestSpy.mockResolvedValue({ ok: false, reason: 'unavailable', message: 'down' })
    expect(await captured.definition?.provideDefinition(fakeModel(), POSITION)).toEqual([])
    expect(await captured.symbols?.provideDocumentSymbols(fakeModel())).toEqual([])
    expect(
      await captured.formatting?.provideDocumentFormattingEdits(fakeModel(), {
        tabSize: 2,
        insertSpaces: true
      })
    ).toEqual([])
  })

  it('survives a missing preload namespace', async () => {
    ;(globalThis as { window?: unknown }).window = { api: {} }
    expect(await captured.hover?.provideHover(fakeModel(), POSITION)).toBeUndefined()
  })
})
