import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ensureVscodeExtensionsLoaded,
  resetVscodeExtensionsStoreForTests,
  selectExtensionThemes,
  startVscodeExtensionsSubscription,
  useVscodeExtensionsStore
} from './vscode-extensions'

vi.mock('@/lib/monaco-setup', () => ({ monaco: {} }))
vi.mock('@/lib/vscode-extensions/register-extension-contributions', () => ({
  registerVscodeContributions: vi.fn(() => ({
    languages: 1,
    themes: 2,
    grammars: 1,
    snippetLanguages: 1,
    problems: []
  })),
  registeredExtensionThemeIds: vi.fn(() => ['t1'])
}))

function extension(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    extensionId: 'orca.demo',
    displayName: 'Demo',
    version: '1.0.0',
    installDir: 'orca.demo-1.0.0',
    enabled: true,
    themes: [{ id: 't1', label: 'Demo Dark', type: 'dark' }],
    languages: ['demo'],
    grammarScopes: ['source.demo'],
    snippetLanguages: ['demo'],
    commands: [],
    problems: [],
    unsupported: [],
    summary: 'Orca will load 1 theme.',
    ...overrides
  }
}

let api: Record<string, ReturnType<typeof vi.fn>>
let changedListener: (() => void) | null

beforeEach(() => {
  changedListener = null
  api = {
    list: vi.fn(async () => [extension()]),
    contributions: vi.fn(async () => ({
      themes: [],
      languages: [],
      grammars: [],
      snippets: [],
      commands: [],
      configurationDefaults: {}
    })),
    installFromVsix: vi.fn(async () => ({ ok: true, extension: extension() })),
    installFromDirectory: vi.fn(async () => ({ ok: true, extension: extension() })),
    remove: vi.fn(async () => ({ removed: true })),
    readGrammar: vi.fn(),
    onChanged: vi.fn((callback: () => void) => {
      changedListener = callback
      return () => {}
    })
  }
  ;(globalThis as { window?: unknown }).window = { api: { vscodeExtensions: api } }
  resetVscodeExtensionsStoreForTests()
})

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

describe('useVscodeExtensionsStore refresh', () => {
  it('loads the installed list and registers its contributions', async () => {
    await useVscodeExtensionsStore.getState().refresh()
    expect(useVscodeExtensionsStore.getState().extensions).toHaveLength(1)
    expect(useVscodeExtensionsStore.getState().status).toBe('ready')
    expect(useVscodeExtensionsStore.getState().registration).toMatchObject({ themes: 2 })
    expect(useVscodeExtensionsStore.getState().registeredThemeIds).toEqual(['t1'])
  })

  it('re-applies contributions on refresh so a new install registers without a restart', async () => {
    const { registerVscodeContributions } =
      await import('@/lib/vscode-extensions/register-extension-contributions')
    vi.mocked(registerVscodeContributions).mockClear()
    await useVscodeExtensionsStore.getState().refresh()
    await useVscodeExtensionsStore.getState().refresh()
    // Registration itself is idempotent, so running it again is safe.
    expect(registerVscodeContributions).toHaveBeenCalledTimes(2)
  })

  it('reports an error without clearing the status machine', async () => {
    api.list.mockRejectedValueOnce(new Error('main not ready'))
    await useVscodeExtensionsStore.getState().refresh()
    expect(useVscodeExtensionsStore.getState().status).toBe('error')
    expect(useVscodeExtensionsStore.getState().error).toMatch(/main not ready/)
  })

  it('reports no extensions when the bridge is absent', async () => {
    ;(globalThis as { window?: unknown }).window = { api: {} }
    await useVscodeExtensionsStore.getState().refresh()
    expect(useVscodeExtensionsStore.getState()).toMatchObject({
      status: 'ready',
      extensions: []
    })
  })
})

describe('useVscodeExtensionsStore mutations', () => {
  it('refreshes after a successful VSIX install', async () => {
    const result = await useVscodeExtensionsStore.getState().installFromVsix()
    expect(result.ok).toBe(true)
    expect(api.list).toHaveBeenCalled()
  })

  it('does not refresh when the user cancels the picker', async () => {
    api.installFromVsix.mockResolvedValueOnce({ ok: false, canceled: true })
    await useVscodeExtensionsStore.getState().installFromVsix()
    expect(api.list).not.toHaveBeenCalled()
  })

  it('refreshes after a directory install', async () => {
    await useVscodeExtensionsStore.getState().installFromDirectory()
    expect(api.list).toHaveBeenCalled()
  })

  it('refreshes after a removal', async () => {
    expect(await useVscodeExtensionsStore.getState().remove('orca.demo')).toBe(true)
    expect(api.list).toHaveBeenCalled()
  })

  it('does not refresh when removal reports nothing removed', async () => {
    api.remove.mockResolvedValueOnce({ removed: false })
    expect(await useVscodeExtensionsStore.getState().remove('orca.absent')).toBe(false)
    expect(api.list).not.toHaveBeenCalled()
  })

  it('reports install unavailable without the bridge', async () => {
    ;(globalThis as { window?: unknown }).window = { api: {} }
    const result = await useVscodeExtensionsStore.getState().installFromVsix()
    expect(result).toMatchObject({ ok: false })
    expect(await useVscodeExtensionsStore.getState().remove('x')).toBe(false)
  })
})

describe('ensureVscodeExtensionsLoaded', () => {
  it('loads once no matter how many editors ask', async () => {
    ensureVscodeExtensionsLoaded()
    ensureVscodeExtensionsLoaded()
    await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(1))
    expect(api.onChanged).toHaveBeenCalledTimes(1)
  })

  it('does nothing without the bridge', () => {
    ;(globalThis as { window?: unknown }).window = { api: {} }
    resetVscodeExtensionsStoreForTests()
    expect(() => ensureVscodeExtensionsLoaded()).not.toThrow()
  })
})

describe('startVscodeExtensionsSubscription', () => {
  it('subscribes once and refreshes on a change from another window', async () => {
    startVscodeExtensionsSubscription()
    startVscodeExtensionsSubscription()
    expect(api.onChanged).toHaveBeenCalledTimes(1)
    changedListener?.()
    await vi.waitFor(() => expect(api.list).toHaveBeenCalled())
  })

  it('does nothing without the bridge', () => {
    ;(globalThis as { window?: unknown }).window = { api: {} }
    resetVscodeExtensionsStoreForTests()
    expect(() => startVscodeExtensionsSubscription()).not.toThrow()
  })
})

describe('selectExtensionThemes', () => {
  it('collects themes from enabled extensions', async () => {
    await useVscodeExtensionsStore.getState().refresh()
    expect(selectExtensionThemes(useVscodeExtensionsStore.getState())).toEqual([
      { id: 't1', label: 'Demo Dark', type: 'dark', extensionId: 'orca.demo' }
    ])
  })

  it('omits themes from a disabled extension', async () => {
    api.list.mockResolvedValueOnce([extension({ enabled: false })])
    await useVscodeExtensionsStore.getState().refresh()
    expect(selectExtensionThemes(useVscodeExtensionsStore.getState())).toEqual([])
  })

  it('is empty before anything loads', () => {
    expect(selectExtensionThemes(useVscodeExtensionsStore.getState())).toEqual([])
  })
})
