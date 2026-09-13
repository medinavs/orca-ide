import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVscodeExtensionStore } from './vscode-extension-store'

let sandbox: string
let root: string
let source: string

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'orca-vsx-store-'))
  root = join(sandbox, 'installed')
  source = join(sandbox, 'source')
  mkdirSync(source, { recursive: true })
})

afterEach(() => rmSync(sandbox, { recursive: true, force: true }))

function writeThemeExtension(
  directory: string,
  overrides: { name?: string; version?: string; label?: string } = {}
): void {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'theme.json'), JSON.stringify({ type: 'dark', name: 'T' }))
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({
      name: overrides.name ?? 'demo-theme',
      version: overrides.version ?? '1.0.0',
      publisher: 'orca',
      contributes: {
        themes: [
          { label: overrides.label ?? 'Demo', uiTheme: 'vs-dark', path: './theme.json' }
        ]
      }
    })
  )
}

describe('createVscodeExtensionStore install', () => {
  it('installs an extension into a versioned directory', () => {
    writeThemeExtension(source)
    const store = createVscodeExtensionStore({ root })
    const result = store.installFromDirectory(source)
    expect(result.ok).toBe(true)
    expect(result.ok && result.extension.extensionId).toBe('orca.demo-theme')
    expect(readdirSync(root)).toEqual(['orca.demo-theme-1.0.0'])
  })

  it('reports the compatibility summary when nothing is usable', () => {
    mkdirSync(source, { recursive: true })
    writeFileSync(
      join(source, 'package.json'),
      JSON.stringify({
        name: 'debug-only',
        version: '1.0.0',
        publisher: 'orca',
        contributes: { debuggers: [{ type: 'x' }] }
      })
    )
    const store = createVscodeExtensionStore({ root })
    const result = store.installFromDirectory(source)
    // Refused in the report's own words, not a generic failure.
    expect(result).toEqual({
      ok: false,
      error: 'Orca found nothing in this extension it can use.'
    })
    expect(existsSync(root)).toBe(false)
  })

  it('reports an unreadable source without installing it', () => {
    const store = createVscodeExtensionStore({ root })
    expect(store.installFromDirectory(source).ok).toBe(false)
  })

  it('replaces a reinstalled version wholesale', () => {
    writeThemeExtension(source)
    const store = createVscodeExtensionStore({ root })
    store.installFromDirectory(source)
    writeFileSync(join(root, 'orca.demo-theme-1.0.0', 'stale.txt'), 'leftover')
    store.installFromDirectory(source)
    // A mix of old and new files is the bug this guards against.
    expect(existsSync(join(root, 'orca.demo-theme-1.0.0', 'stale.txt'))).toBe(false)
  })

  it('keeps two versions of the same extension apart', () => {
    writeThemeExtension(source)
    const store = createVscodeExtensionStore({ root })
    store.installFromDirectory(source)
    writeThemeExtension(source, { version: '2.0.0' })
    store.installFromDirectory(source)
    expect(readdirSync(root).sort()).toEqual([
      'orca.demo-theme-1.0.0',
      'orca.demo-theme-2.0.0'
    ])
  })
})

describe('createVscodeExtensionStore list', () => {
  it('lists an installed extension with its contributions', () => {
    writeThemeExtension(source)
    const store = createVscodeExtensionStore({ root })
    store.installFromDirectory(source)
    const listed = store.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      extensionId: 'orca.demo-theme',
      version: '1.0.0',
      enabled: true,
      themes: [{ label: 'Demo', type: 'dark' }],
      summary: 'Orca will load 1 theme.'
    })
  })

  it('is empty when nothing is installed', () => {
    expect(createVscodeExtensionStore({ root }).list()).toEqual([])
  })

  it('skips an unreadable directory rather than hiding the rest', () => {
    writeThemeExtension(source)
    const store = createVscodeExtensionStore({ root })
    store.installFromDirectory(source)
    mkdirSync(join(root, 'broken-install'), { recursive: true })
    writeFileSync(join(root, 'broken-install', 'package.json'), 'not json')
    expect(store.list().map((entry) => entry.extensionId)).toEqual(['orca.demo-theme'])
  })

  it('reflects the enabled predicate', () => {
    writeThemeExtension(source)
    const store = createVscodeExtensionStore({ root, isEnabled: () => false })
    store.installFromDirectory(source)
    expect(store.list()[0]!.enabled).toBe(false)
  })
})

describe('createVscodeExtensionStore loadEnabled', () => {
  it('loads only enabled extensions', () => {
    writeThemeExtension(source, { name: 'kept' })
    const kept = createVscodeExtensionStore({ root })
    kept.installFromDirectory(source)
    writeThemeExtension(source, { name: 'skipped' })
    kept.installFromDirectory(source)

    const store = createVscodeExtensionStore({
      root,
      isEnabled: (id) => id === 'orca.kept'
    })
    expect(store.loadEnabled().map((entry) => entry.extensionId)).toEqual(['orca.kept'])
  })

  it('returns fully loaded contributions, not just a summary', () => {
    writeThemeExtension(source)
    const store = createVscodeExtensionStore({ root })
    store.installFromDirectory(source)
    const loaded = store.loadEnabled()
    expect(loaded[0]!.themes[0]!.data.base).toBe('vs-dark')
  })
})

describe('createVscodeExtensionStore remove', () => {
  it('removes an installed extension', () => {
    writeThemeExtension(source)
    const store = createVscodeExtensionStore({ root })
    store.installFromDirectory(source)
    expect(store.remove('orca.demo-theme')).toBe(true)
    expect(store.list()).toEqual([])
  })

  it('removes every version of the extension', () => {
    writeThemeExtension(source)
    const store = createVscodeExtensionStore({ root })
    store.installFromDirectory(source)
    writeThemeExtension(source, { version: '2.0.0' })
    store.installFromDirectory(source)
    expect(store.remove('orca.demo-theme')).toBe(true)
    expect(readdirSync(root)).toEqual([])
  })

  it('reports false for an extension that is not installed', () => {
    expect(createVscodeExtensionStore({ root }).remove('orca.absent')).toBe(false)
  })
})

describe('createVscodeExtensionStore directoryFor', () => {
  it('returns the install directory', () => {
    writeThemeExtension(source)
    const store = createVscodeExtensionStore({ root })
    store.installFromDirectory(source)
    expect(store.directoryFor('orca.demo-theme')).toBe(join(root, 'orca.demo-theme-1.0.0'))
  })

  it('returns null when not installed', () => {
    expect(createVscodeExtensionStore({ root }).directoryFor('orca.absent')).toBeNull()
  })
})
