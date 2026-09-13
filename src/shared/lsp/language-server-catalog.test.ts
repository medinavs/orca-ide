import { describe, expect, it } from 'vitest'
import {
  LANGUAGE_SERVER_CATALOG,
  languageServerForLanguage,
  resolveLanguageServers
} from './language-server-catalog'

describe('LANGUAGE_SERVER_CATALOG', () => {
  it('has a unique id and an install hint for every entry', () => {
    const ids = LANGUAGE_SERVER_CATALOG.map((spec) => spec.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const spec of LANGUAGE_SERVER_CATALOG) {
      expect(spec.installHint).not.toBe('')
      expect(spec.languageIds.length).toBeGreaterThan(0)
    }
  })

  it('claims each language id only once, so selection is unambiguous', () => {
    const claimed = LANGUAGE_SERVER_CATALOG.flatMap((spec) => [...spec.languageIds])
    expect(new Set(claimed).size).toBe(claimed.length)
  })

  it('names bare programs so the execution host resolves them on its own PATH', () => {
    for (const spec of LANGUAGE_SERVER_CATALOG) {
      expect(spec.command).not.toMatch(/[\\/]/)
    }
  })
})

describe('resolveLanguageServers', () => {
  it('returns the catalog unchanged with no overrides', () => {
    expect(resolveLanguageServers()).toEqual([...LANGUAGE_SERVER_CATALOG])
  })

  it('replaces the argv of a catalog server', () => {
    const [gopls] = resolveLanguageServers({ gopls: { command: ['gopls', '-rpc.trace'] } })
    expect(gopls).toMatchObject({ id: 'gopls', command: 'gopls', args: ['-rpc.trace'] })
  })

  it('keeps catalog args when the override names only a program', () => {
    const resolved = resolveLanguageServers({ typescript: { command: ['tsserver-lsp'] } })
    const typescript = resolved.find((spec) => spec.id === 'typescript')
    expect(typescript).toMatchObject({ command: 'tsserver-lsp', args: [] })
  })

  it('drops a disabled server', () => {
    const ids = resolveLanguageServers({ gopls: { enabled: false } }).map((spec) => spec.id)
    expect(ids).not.toContain('gopls')
  })

  it('adds a user-defined server', () => {
    const resolved = resolveLanguageServers({
      zls: { command: ['zls'], languageIds: ['zig'] }
    })
    expect(resolved.at(-1)).toMatchObject({ id: 'zls', command: 'zls', languageIds: ['zig'] })
  })

  it('ignores a user-defined entry missing its command or languages', () => {
    expect(resolveLanguageServers({ zls: { languageIds: ['zig'] } })).toHaveLength(
      LANGUAGE_SERVER_CATALOG.length
    )
    expect(resolveLanguageServers({ zls: { command: ['zls'] } })).toHaveLength(
      LANGUAGE_SERVER_CATALOG.length
    )
  })

  it('lets an override retarget which languages a catalog server serves', () => {
    const resolved = resolveLanguageServers({ typescript: { languageIds: ['typescript'] } })
    expect(languageServerForLanguage('javascript', { typescript: { languageIds: ['typescript'] } }))
      .toBeNull()
    expect(resolved.find((spec) => spec.id === 'typescript')?.languageIds).toEqual(['typescript'])
  })
})

describe('languageServerForLanguage', () => {
  it('selects the catalog server for a known language', () => {
    expect(languageServerForLanguage('go')?.id).toBe('gopls')
    expect(languageServerForLanguage('javascript')?.id).toBe('typescript')
  })

  it('returns null for a language no server claims', () => {
    expect(languageServerForLanguage('markdown')).toBeNull()
  })
})
