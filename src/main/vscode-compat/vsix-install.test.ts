import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildVsix, buildZip } from './__fixtures__/build-zip'
import {
  findZipEntry,
  isSafeZipEntryPath,
  readZipCentralDirectory,
  readZipEntry
} from './vsix-archive'
import { extractVsix, installVsixFile } from './vsix-install'
import { createVscodeExtensionStore } from './vscode-extension-store'

let sandbox: string

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'orca-vsix-install-'))
})

afterEach(() => rmSync(sandbox, { recursive: true, force: true }))

const THEME_MANIFEST = {
  name: 'demo-theme',
  version: '1.0.0',
  publisher: 'orca',
  contributes: {
    themes: [{ label: 'Demo', uiTheme: 'vs-dark', path: './theme.json' }]
  }
}

describe('isSafeZipEntryPath', () => {
  it('accepts ordinary entry names', () => {
    expect(isSafeZipEntryPath('extension/package.json')).toBe(true)
    expect(isSafeZipEntryPath('a/b/c.json')).toBe(true)
  })

  it('refuses traversal, absolute, drive and UNC names', () => {
    expect(isSafeZipEntryPath('../../.ssh/authorized_keys')).toBe(false)
    expect(isSafeZipEntryPath('/etc/passwd')).toBe(false)
    expect(isSafeZipEntryPath('C:/Windows/system32/x')).toBe(false)
    expect(isSafeZipEntryPath('//server/share/x')).toBe(false)
    expect(isSafeZipEntryPath('a/../../b')).toBe(false)
  })

  it('refuses a backslash traversal, which Windows would honour', () => {
    expect(isSafeZipEntryPath('..\\..\\secret')).toBe(false)
  })

  it('refuses an empty name, a NUL and an absurdly long one', () => {
    expect(isSafeZipEntryPath('')).toBe(false)
    expect(isSafeZipEntryPath('a\0b')).toBe(false)
    expect(isSafeZipEntryPath('a'.repeat(2000))).toBe(false)
  })
})

describe('readZipCentralDirectory', () => {
  it('lists entries from a real archive', () => {
    const archive = buildZip([
      { path: 'a.txt', contents: 'hello' },
      { path: 'b/c.txt', contents: 'world', method: 0 }
    ])
    const result = readZipCentralDirectory(archive)
    expect(result.ok && result.value.map((entry) => entry.path)).toEqual(['a.txt', 'b/c.txt'])
  })

  it('rejects a non-archive that is long enough to scan', () => {
    // Long enough to pass the size floor, so this exercises the directory
    // search rather than the length check below.
    expect(readZipCentralDirectory(Buffer.from('not a zip archive at all, really'))).toEqual({
      ok: false,
      error: 'not a valid .vsix archive (no ZIP directory found)'
    })
  })

  it('rejects a file too small to be an archive', () => {
    expect(readZipCentralDirectory(Buffer.alloc(4))).toEqual({
      ok: false,
      error: 'file is too small to be a .vsix archive'
    })
  })

  it('rejects an entry with an unsafe path', () => {
    const archive = buildZip([{ path: '../escape.txt', contents: 'x' }])
    const result = readZipCentralDirectory(archive)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toMatch(/unsafe path/)
  })

  it('rejects an encrypted entry rather than producing garbage', () => {
    const archive = buildZip([{ path: 'a.txt', contents: 'x', encrypted: true }])
    expect(readZipCentralDirectory(archive)).toEqual({
      ok: false,
      error: 'encrypted .vsix archives are not supported'
    })
  })

  it('rejects an entry declaring an absurd expanded size', () => {
    // The zip-bomb shape: a tiny archive claiming a huge expansion.
    const archive = buildZip([
      { path: 'bomb.txt', contents: 'x', declaredUncompressedSize: 500 * 1024 * 1024 }
    ])
    const result = readZipCentralDirectory(archive)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toMatch(/too large/)
  })

  it('rejects a truncated directory', () => {
    const archive = buildZip([{ path: 'a.txt', contents: 'hello' }])
    const truncated = Buffer.concat([archive.subarray(0, -22), archive.subarray(-22)])
    truncated.writeUInt32LE(truncated.length + 500, truncated.length - 6)
    expect(readZipCentralDirectory(truncated).ok).toBe(false)
  })
})

describe('readZipEntry', () => {
  it('inflates a deflated entry', () => {
    const archive = buildZip([{ path: 'a.txt', contents: 'hello world'.repeat(20) }])
    const directory = readZipCentralDirectory(archive)
    const entry = directory.ok ? findZipEntry(directory.value, 'a.txt') : null
    const contents = entry ? readZipEntry(archive, entry) : null
    expect(contents?.ok && contents.value.toString('utf8')).toBe('hello world'.repeat(20))
  })

  it('reads a stored entry', () => {
    const archive = buildZip([{ path: 'a.txt', contents: 'plain', method: 0 }])
    const directory = readZipCentralDirectory(archive)
    const entry = directory.ok ? findZipEntry(directory.value, 'a.txt') : null
    const contents = entry ? readZipEntry(archive, entry) : null
    expect(contents?.ok && contents.value.toString('utf8')).toBe('plain')
  })

  it('finds an entry case-insensitively', () => {
    const archive = buildZip([{ path: 'Extension/Package.json', contents: '{}' }])
    const directory = readZipCentralDirectory(archive)
    expect(directory.ok && findZipEntry(directory.value, 'extension/package.json')).not.toBeNull()
  })
})

describe('extractVsix', () => {
  it('extracts the extension subtree and strips the prefix', () => {
    const archive = buildVsix(THEME_MANIFEST, [
      { path: 'theme.json', contents: '{"type":"dark"}' }
    ])
    const destination = join(sandbox, 'out')
    expect(extractVsix(archive, destination).ok).toBe(true)
    expect(existsSync(join(destination, 'package.json'))).toBe(true)
    expect(existsSync(join(destination, 'theme.json'))).toBe(true)
    // Packaging metadata outside `extension/` is not extracted.
    expect(existsSync(join(destination, 'extension.vsixmanifest'))).toBe(false)
  })

  it('creates nested directories', () => {
    const archive = buildVsix(THEME_MANIFEST, [
      { path: 'syntaxes/deep/go.json', contents: '{}' }
    ])
    const destination = join(sandbox, 'out')
    extractVsix(archive, destination)
    expect(existsSync(join(destination, 'syntaxes', 'deep', 'go.json'))).toBe(true)
  })

  it('refuses an archive with no extension manifest', () => {
    const archive = buildZip([{ path: 'readme.txt', contents: 'nothing here' }])
    expect(extractVsix(archive, join(sandbox, 'out'))).toEqual({
      ok: false,
      error: 'the .vsix contains no extension/package.json'
    })
  })

  it('refuses a malformed archive', () => {
    expect(extractVsix(Buffer.from('garbage'), join(sandbox, 'out')).ok).toBe(false)
  })
})

describe('installVsixFile', () => {
  function writeVsix(archive: Buffer, name = 'demo.vsix'): string {
    const path = join(sandbox, name)
    writeFileSync(path, archive)
    return path
  }

  it('installs a theme extension end to end', () => {
    const path = writeVsix(
      buildVsix(THEME_MANIFEST, [{ path: 'theme.json', contents: '{"type":"dark"}' }])
    )
    const store = createVscodeExtensionStore({ root: join(sandbox, 'installed') })
    const result = installVsixFile(path, { store, stagingRoot: join(sandbox, 'staging') })
    expect(result.ok).toBe(true)
    expect(result.ok && result.extension.extensionId).toBe('orca.demo-theme')
    expect(store.list().map((entry) => entry.extensionId)).toEqual(['orca.demo-theme'])
  })

  it('leaves nothing installed when the archive is incompatible', () => {
    const path = writeVsix(
      buildVsix({ name: 'debug-only', version: '1.0.0', publisher: 'orca', contributes: { debuggers: [] } })
    )
    const root = join(sandbox, 'installed')
    const store = createVscodeExtensionStore({ root })
    const result = installVsixFile(path, { store, stagingRoot: join(sandbox, 'staging') })
    expect(result.ok).toBe(false)
    expect(store.list()).toEqual([])
  })

  it('leaves no staging copies behind when the install fails', () => {
    const staging = join(sandbox, 'staging')
    const path = writeVsix(Buffer.from('not a zip archive at all, really'))
    const store = createVscodeExtensionStore({ root: join(sandbox, 'installed') })
    expect(installVsixFile(path, { store, stagingRoot: staging }).ok).toBe(false)
    // Without the `finally` cleanup, every failed install would accumulate a
    // half-extracted directory here.
    expect(existsSync(staging) ? readdirSync(staging) : []).toEqual([])
  })

  it('reports a missing file', () => {
    const store = createVscodeExtensionStore({ root: join(sandbox, 'installed') })
    expect(
      installVsixFile(join(sandbox, 'absent.vsix'), { store, stagingRoot: sandbox })
    ).toEqual({ ok: false, error: 'the .vsix could not be read' })
  })

  it('refuses a directory given in place of a .vsix', () => {
    mkdirSync(join(sandbox, 'adir'))
    const store = createVscodeExtensionStore({ root: join(sandbox, 'installed') })
    expect(installVsixFile(join(sandbox, 'adir'), { store, stagingRoot: sandbox })).toEqual({
      ok: false,
      error: 'not a file'
    })
  })

  it('installs snippets and a language configuration from a .vsix', () => {
    const path = writeVsix(
      buildVsix(
        {
          name: 'lang-pack',
          version: '2.1.0',
          publisher: 'orca',
          contributes: {
            languages: [
              { id: 'demo', extensions: ['.demo'], configuration: './lang.json' }
            ],
            snippets: [{ language: 'demo', path: './snips.json' }]
          }
        },
        [
          { path: 'lang.json', contents: '{ "comments": { "lineComment": "#" } }' },
          {
            path: 'snips.json',
            contents: JSON.stringify({ Hello: { prefix: 'hi', body: 'hello $1' } })
          }
        ]
      )
    )
    const store = createVscodeExtensionStore({ root: join(sandbox, 'installed') })
    const result = installVsixFile(path, { store, stagingRoot: join(sandbox, 'staging') })
    expect(result.ok).toBe(true)
    const loaded = store.loadEnabled()[0]!
    expect(loaded.languages[0]!.configuration?.comments?.lineComment).toBe('#')
    expect(loaded.snippets[0]!.snippets[0]!.prefix).toBe('hi')
  })
})
