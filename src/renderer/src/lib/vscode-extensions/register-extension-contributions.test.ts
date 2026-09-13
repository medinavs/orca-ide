import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VscodeContributionBundle } from '../../../../main/vscode-compat/vscode-extension-service'
import {
  registerVscodeContributions,
  registeredExtensionThemeIds,
  resetVscodeContributionRegistrationForTests
} from './register-extension-contributions'
import {
  extensionSnippetsFor,
  resetExtensionSnippetsForTests
} from './extension-snippet-provider'

type Registered = {
  themes: { id: string; data: unknown }[]
  languages: { id: string }[]
  configurations: { id: string; configuration: unknown }[]
  tokensProviders: string[]
  completionProviders: string[]
}

let registered: Registered
let knownLanguages: { id: string }[]
let defineThemeImpl: (id: string, data: unknown) => void

function fakeMonaco(): Parameters<typeof registerVscodeContributions>[0] {
  return {
    editor: {
      defineTheme: (id: string, data: unknown) => {
        defineThemeImpl(id, data)
        registered.themes.push({ id, data })
      }
    },
    languages: {
      getLanguages: () => knownLanguages,
      register: (language: { id: string }) => {
        registered.languages.push(language)
        knownLanguages.push(language)
      },
      setLanguageConfiguration: (id: string, configuration: unknown) => {
        registered.configurations.push({ id, configuration })
        return { dispose: () => {} }
      },
      registerTokensProviderFactory: (id: string) => {
        registered.tokensProviders.push(id)
        return { dispose: () => {} }
      },
      registerCompletionItemProvider: (id: string) => {
        registered.completionProviders.push(id)
        return { dispose: () => {} }
      }
    }
  } as unknown as Parameters<typeof registerVscodeContributions>[0]
}

function bundle(overrides: Partial<VscodeContributionBundle> = {}): VscodeContributionBundle {
  return {
    themes: [],
    languages: [],
    grammars: [],
    snippets: [],
    commands: [],
    configurationDefaults: {},
    ...overrides
  }
}

beforeEach(() => {
  registered = {
    themes: [],
    languages: [],
    configurations: [],
    tokensProviders: [],
    completionProviders: []
  }
  knownLanguages = [{ id: 'go' }]
  defineThemeImpl = () => {}
  resetVscodeContributionRegistrationForTests()
  resetExtensionSnippetsForTests()
  ;(globalThis as { window?: unknown }).window = { api: {} }
})

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

describe('registerVscodeContributions themes', () => {
  it('defines each theme in Monaco', () => {
    const summary = registerVscodeContributions(
      fakeMonaco(),
      bundle({
        themes: [
          {
            id: 'vscode-demo-dark',
            label: 'Demo',
            type: 'dark',
            extensionId: 'orca.demo',
            data: { base: 'vs-dark', inherit: true, rules: [], colors: {} }
          }
        ]
      })
    )
    expect(summary.themes).toBe(1)
    expect(registered.themes[0]!.id).toBe('vscode-demo-dark')
    expect(registeredExtensionThemeIds()).toEqual(['vscode-demo-dark'])
  })

  it('does not redefine a theme on a second call', () => {
    const contributions = bundle({
      themes: [
        {
          id: 't',
          label: 'T',
          type: 'dark',
          extensionId: 'x',
          data: { base: 'vs-dark', inherit: true, rules: [], colors: {} }
        }
      ]
    })
    registerVscodeContributions(fakeMonaco(), contributions)
    const summary = registerVscodeContributions(fakeMonaco(), contributions)
    expect(summary.themes).toBe(0)
    expect(registered.themes).toHaveLength(1)
  })

  it('keeps registering after one theme is rejected', () => {
    defineThemeImpl = (id) => {
      if (id === 'bad') {
        throw new Error('malformed')
      }
    }
    const summary = registerVscodeContributions(
      fakeMonaco(),
      bundle({
        themes: [
          { id: 'bad', label: 'Bad', type: 'dark', extensionId: 'x', data: {} as never },
          {
            id: 'good',
            label: 'Good',
            type: 'dark',
            extensionId: 'x',
            data: { base: 'vs-dark', inherit: true, rules: [], colors: {} }
          }
        ]
      })
    )
    expect(summary.themes).toBe(1)
    expect(summary.problems.join(' ')).toMatch(/"Bad" was rejected/)
  })
})

describe('registerVscodeContributions languages', () => {
  it('registers a new language with its extensions and configuration', () => {
    const summary = registerVscodeContributions(
      fakeMonaco(),
      bundle({
        languages: [
          {
            extensionId: 'orca.demo',
            id: 'demo',
            extensions: ['.demo'],
            aliases: ['Demo'],
            filenames: [],
            configuration: { comments: { lineComment: '#' } }
          }
        ]
      })
    )
    expect(summary.languages).toBe(1)
    expect(registered.languages[0]).toMatchObject({ id: 'demo', extensions: ['.demo'] })
    expect(registered.configurations[0]!.id).toBe('demo')
  })

  it('does not re-register a language Monaco already knows', () => {
    // `go` is built in; re-registering it would shadow Monaco's own setup.
    const summary = registerVscodeContributions(
      fakeMonaco(),
      bundle({
        languages: [
          { extensionId: 'x', id: 'go', extensions: ['.go'], aliases: [], filenames: [] }
        ]
      })
    )
    expect(summary.languages).toBe(0)
    expect(registered.languages).toEqual([])
  })

  it('still applies a configuration to an already-known language', () => {
    registerVscodeContributions(
      fakeMonaco(),
      bundle({
        languages: [
          {
            extensionId: 'x',
            id: 'go',
            extensions: [],
            aliases: [],
            filenames: [],
            configuration: { comments: { lineComment: '//' } }
          }
        ]
      })
    )
    expect(registered.configurations[0]!.id).toBe('go')
  })
})

describe('registerVscodeContributions grammars', () => {
  it('registers a tokens provider for a grammar bound to a language', () => {
    const summary = registerVscodeContributions(
      fakeMonaco(),
      bundle({
        languages: [
          { extensionId: 'x', id: 'demo', extensions: ['.demo'], aliases: [], filenames: [] }
        ],
        grammars: [{ extensionId: 'x', scopeName: 'source.demo', languageId: 'demo' }]
      })
    )
    expect(summary.grammars).toBe(1)
    expect(registered.tokensProviders).toContain('demo')
  })

  it('skips an injection-only grammar with no language', () => {
    // Orca has no injection support; attaching it to nothing would mislead.
    const summary = registerVscodeContributions(
      fakeMonaco(),
      bundle({ grammars: [{ extensionId: 'x', scopeName: 'source.inject' }] })
    )
    expect(summary.grammars).toBe(0)
    expect(registered.tokensProviders).toEqual([])
  })

  it('registers a scope only once', () => {
    const contributions = bundle({
      languages: [
        { extensionId: 'x', id: 'demo', extensions: [], aliases: [], filenames: [] }
      ],
      grammars: [{ extensionId: 'x', scopeName: 'source.demo', languageId: 'demo' }]
    })
    registerVscodeContributions(fakeMonaco(), contributions)
    const summary = registerVscodeContributions(fakeMonaco(), contributions)
    expect(summary.grammars).toBe(0)
  })
})

describe('registerVscodeContributions snippets', () => {
  const SNIPPET = { prefix: 'for', body: 'for $1 {}', name: 'For', hasTabStops: true }

  it('registers one completion provider per language', () => {
    const summary = registerVscodeContributions(
      fakeMonaco(),
      bundle({
        snippets: [{ extensionId: 'x', languageId: 'go', snippets: [SNIPPET] }]
      })
    )
    expect(summary.snippetLanguages).toBe(1)
    expect(registered.completionProviders).toEqual(['go'])
    expect(extensionSnippetsFor('go')).toHaveLength(1)
  })

  it('merges snippets from two extensions for the same language', () => {
    registerVscodeContributions(
      fakeMonaco(),
      bundle({
        snippets: [
          { extensionId: 'a', languageId: 'go', snippets: [SNIPPET] },
          { extensionId: 'b', languageId: 'go', snippets: [{ ...SNIPPET, prefix: 'iferr' }] }
        ]
      })
    )
    expect(extensionSnippetsFor('go').map((snippet) => snippet.prefix)).toEqual([
      'for',
      'iferr'
    ])
    // One provider for the language, not one per extension.
    expect(registered.completionProviders).toEqual(['go'])
  })

  it('drops a removed extension snippets without leaving a dead provider', () => {
    const monaco = fakeMonaco()
    registerVscodeContributions(
      monaco,
      bundle({ snippets: [{ extensionId: 'a', languageId: 'go', snippets: [SNIPPET] }] })
    )
    registerVscodeContributions(monaco, bundle({ snippets: [] }))
    expect(extensionSnippetsFor('go')).toEqual([])
    // The provider stays registered but now answers nothing, which is the
    // only shape Monaco allows — it cannot unregister a provider.
    expect(registered.completionProviders).toEqual(['go'])
  })

  it('reports no snippet languages for an empty bundle', () => {
    expect(registerVscodeContributions(fakeMonaco(), bundle()).snippetLanguages).toBe(0)
  })
})

describe('registerVscodeContributions ordering', () => {
  it('registers languages before grammars so a tokenizer has a language', () => {
    const monaco = fakeMonaco()
    const order: string[] = []
    const wrapped = {
      ...monaco,
      languages: {
        ...monaco.languages,
        register: (language: { id: string }) => {
          order.push(`language:${language.id}`)
          knownLanguages.push(language)
        },
        registerTokensProviderFactory: (id: string) => {
          order.push(`grammar:${id}`)
          return { dispose: () => {} }
        }
      }
    } as unknown as Parameters<typeof registerVscodeContributions>[0]
    registerVscodeContributions(
      wrapped,
      bundle({
        languages: [
          { extensionId: 'x', id: 'demo', extensions: [], aliases: [], filenames: [] }
        ],
        grammars: [{ extensionId: 'x', scopeName: 'source.demo', languageId: 'demo' }]
      })
    )
    expect(order).toEqual(['language:demo', 'grammar:demo'])
  })

  it('handles a completely empty bundle without touching Monaco', () => {
    const summary = registerVscodeContributions(fakeMonaco(), bundle())
    expect(summary).toEqual({
      languages: 0,
      themes: 0,
      grammars: 0,
      snippetLanguages: 0,
      problems: []
    })
    expect(registered.languages).toEqual([])
  })
})

describe('grammar body loading', () => {
  /** Captures the factory Monaco is handed, so the lazy path can be driven. */
  function monacoCapturingFactory(): {
    monaco: Parameters<typeof registerVscodeContributions>[0]
    factory: () => { create: () => unknown } | null
  } {
    let captured: { create: () => unknown } | null = null
    const base = fakeMonaco()
    const monaco = {
      ...base,
      languages: {
        ...base.languages,
        registerTokensProviderFactory: (_id: string, provider: { create: () => unknown }) => {
          captured = provider
          return { dispose: () => {} }
        }
      }
    } as unknown as Parameters<typeof registerVscodeContributions>[0]
    return { monaco, factory: () => captured }
  }

  /** Stands in for the real provider module, which needs the wasm engine. */
  const fakeProviderModule = {
    createTextMateTokensProvider: ({
      loadGrammar
    }: {
      loadGrammar: () => Promise<unknown>
    }) => {
      void loadGrammar()
      return { getInitialState: () => ({}), tokenize: () => ({ tokens: [], endState: {} }) }
    }
  } as never

  function registerGrammar(
    monaco: Parameters<typeof registerVscodeContributions>[0]
  ): void {
    registerVscodeContributions(
      monaco,
      bundle({
        languages: [
          { extensionId: 'orca.demo', id: 'demo', extensions: [], aliases: [], filenames: [] }
        ],
        grammars: [{ extensionId: 'orca.demo', scopeName: 'source.demo', languageId: 'demo' }]
      }),
      { loadProviderModule: async () => fakeProviderModule }
    )
  }

  it('does not read the grammar until the tokenizer asks', () => {
    const readGrammar = vi.fn()
    ;(globalThis as { window?: unknown }).window = {
      api: { vscodeExtensions: { readGrammar } }
    }
    const { monaco, factory } = monacoCapturingFactory()
    registerGrammar(monaco)
    // A grammar is a large file; registration must not fetch every one.
    expect(readGrammar).not.toHaveBeenCalled()
    expect(factory()).not.toBeNull()
  })

  it('fetches the grammar over IPC on the first tokenization request', async () => {
    const readGrammar = vi.fn(async () => ({ ok: true as const, contents: '{"x":1}' }))
    ;(globalThis as { window?: unknown }).window = {
      api: { vscodeExtensions: { readGrammar } }
    }
    const { monaco, factory } = monacoCapturingFactory()
    registerGrammar(monaco)
    await factory()?.create()
    expect(readGrammar).toHaveBeenCalledWith({
      extensionId: 'orca.demo',
      scopeName: 'source.demo'
    })
  })
})
