import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readContainedFile } from './contained-file-read'
import { readVscodeExtension } from './vscode-extension-reader'

let sandbox: string
let root: string
let outside: string

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'orca-vsx-'))
  root = join(sandbox, 'extension')
  outside = join(sandbox, 'outside')
  mkdirSync(root, { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'secret.txt'), 'do not read me')
})

afterEach(() => rmSync(sandbox, { recursive: true, force: true }))

function writeManifest(manifest: unknown): void {
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest))
}

const BASE = { name: 'demo', version: '1.0.0', publisher: 'orca' }

describe('readContainedFile', () => {
  it('reads a file inside the extension', () => {
    writeFileSync(join(root, 'a.json'), '{"a":1}')
    expect(readContainedFile(root, 'a.json')).toEqual({ ok: true, contents: '{"a":1}' })
  })

  it('reads through a subdirectory', () => {
    mkdirSync(join(root, 'themes'))
    writeFileSync(join(root, 'themes', 'dark.json'), '{}')
    expect(readContainedFile(root, 'themes/dark.json').ok).toBe(true)
  })

  it('refuses an absolute path', () => {
    expect(readContainedFile(root, join(outside, 'secret.txt'))).toEqual({
      ok: false,
      error: 'path must be relative to the extension directory'
    })
  })

  it('refuses a traversal path', () => {
    expect(readContainedFile(root, '../outside/secret.txt').ok).toBe(false)
  })

  it('refuses a symlink escaping the extension directory', () => {
    // The whole reason containment is decided on the real path: this relative
    // path passes every textual check and still reads outside the extension.
    try {
      symlinkSync(join(outside, 'secret.txt'), join(root, 'link.json'))
    } catch {
      return // unprivileged Windows cannot create symlinks; nothing to assert
    }
    expect(readContainedFile(root, 'link.json')).toEqual({
      ok: false,
      error: 'path escapes the extension directory'
    })
  })

  it('does not treat a sibling directory with a shared prefix as inside', () => {
    const evil = `${root}-evil`
    mkdirSync(evil, { recursive: true })
    writeFileSync(join(evil, 'x.json'), '{}')
    expect(readContainedFile(root, '../extension-evil/x.json').ok).toBe(false)
  })

  it('reports a missing file', () => {
    expect(readContainedFile(root, 'absent.json')).toEqual({ ok: false, error: 'file not found' })
  })

  it('refuses a directory', () => {
    mkdirSync(join(root, 'themes'))
    expect(readContainedFile(root, 'themes')).toEqual({ ok: false, error: 'path is not a file' })
  })

  it('refuses an oversized file', () => {
    writeFileSync(join(root, 'big.json'), 'x'.repeat(500))
    expect(readContainedFile(root, 'big.json', 100).ok).toBe(false)
  })
})

describe('readVscodeExtension', () => {
  it('reports a missing manifest', () => {
    const result = readVscodeExtension(root)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toMatch(/package.json/)
  })

  it('reports an unparseable manifest', () => {
    writeFileSync(join(root, 'package.json'), '{ not json')
    const result = readVscodeExtension(root)
    expect(result.ok === false && result.error).toMatch(/not valid JSON/)
  })

  it('accepts a manifest with JSONC comments', () => {
    writeFileSync(
      join(root, 'package.json'),
      '{\n  // published extensions really do this\n  "name": "demo",\n  "version": "1.0.0"\n}'
    )
    expect(readVscodeExtension(root).ok).toBe(true)
  })

  it('reads an extension id and compatibility report', () => {
    writeManifest(BASE)
    const result = readVscodeExtension(root)
    expect(result.ok && result.extension.extensionId).toBe('orca.demo')
    expect(result.ok && result.extension.report.usable).toBe(false)
  })
})

describe('readVscodeExtension themes', () => {
  it('loads a theme and adapts it', () => {
    mkdirSync(join(root, 'themes'))
    writeFileSync(
      join(root, 'themes', 'dark.json'),
      JSON.stringify({
        name: 'Demo Dark',
        type: 'dark',
        colors: { 'editor.background': '#101010' },
        tokenColors: [{ scope: 'comment', settings: { foreground: '#6A9955' } }]
      })
    )
    writeManifest({
      ...BASE,
      contributes: {
        themes: [{ label: 'Demo Dark', uiTheme: 'vs-dark', path: './themes/dark.json' }]
      }
    })
    const result = readVscodeExtension(root)
    expect(result.ok && result.extension.themes).toEqual([
      {
        id: 'vscode-orca-demo-demo-dark',
        label: 'Demo Dark',
        type: 'dark',
        data: {
          base: 'vs-dark',
          inherit: true,
          rules: [{ token: 'comment', foreground: '6A9955' }],
          colors: { 'editor.background': '#101010' }
        }
      }
    ])
  })

  it('records a missing theme file as a problem and keeps loading', () => {
    writeManifest({
      ...BASE,
      contributes: {
        themes: [
          { label: 'Gone', uiTheme: 'vs-dark', path: './themes/gone.json' },
          { label: 'Fine', uiTheme: 'vs', path: './ok.json' }
        ]
      }
    })
    writeFileSync(join(root, 'ok.json'), '{"type":"light"}')
    const result = readVscodeExtension(root)
    expect(result.ok && result.extension.themes.map((theme) => theme.label)).toEqual(['Fine'])
    expect(result.ok && result.extension.problems.join(' ')).toMatch(/Gone/)
  })

  it('honours an explicit theme id from the manifest', () => {
    writeFileSync(join(root, 'a.json'), '{"type":"dark"}')
    writeManifest({
      ...BASE,
      contributes: {
        themes: [{ id: 'my-theme', label: 'A', uiTheme: 'vs-dark', path: './a.json' }]
      }
    })
    expect(readVscodeExtension(root).ok).toBe(true)
    const result = readVscodeExtension(root)
    expect(result.ok && result.extension.themes[0]!.id).toBe('my-theme')
  })
})

describe('readVscodeExtension languages, grammars and snippets', () => {
  it('loads a language with its configuration', () => {
    writeFileSync(
      join(root, 'language-configuration.json'),
      '{ "comments": { "lineComment": "//" }, "brackets": [["{","}"]] }'
    )
    writeManifest({
      ...BASE,
      contributes: {
        languages: [
          {
            id: 'demo',
            extensions: ['.demo'],
            aliases: ['Demo'],
            configuration: './language-configuration.json'
          }
        ]
      }
    })
    const result = readVscodeExtension(root)
    const language = result.ok ? result.extension.languages[0] : null
    expect(language).toMatchObject({ id: 'demo', extensions: ['.demo'], aliases: ['Demo'] })
    expect(language?.configuration?.comments?.lineComment).toBe('//')
    expect(language?.configuration?.brackets).toEqual([['{', '}']])
  })

  it('keeps a language whose configuration file is missing', () => {
    writeManifest({
      ...BASE,
      contributes: { languages: [{ id: 'demo', configuration: './absent.json' }] }
    })
    const result = readVscodeExtension(root)
    // The language id and extensions are still useful without the config.
    expect(result.ok && result.extension.languages[0]!.id).toBe('demo')
    expect(result.ok && result.extension.problems.join(' ')).toMatch(/Language configuration/)
  })

  it('records a grammar path without reading the grammar body', () => {
    mkdirSync(join(root, 'syntaxes'))
    writeFileSync(join(root, 'syntaxes', 'demo.json'), '{"scopeName":"source.demo"}')
    writeManifest({
      ...BASE,
      contributes: {
        grammars: [
          { language: 'demo', scopeName: 'source.demo', path: './syntaxes/demo.json' }
        ]
      }
    })
    const result = readVscodeExtension(root)
    expect(result.ok && result.extension.grammars[0]).toMatchObject({
      scopeName: 'source.demo',
      languageId: 'demo'
    })
    expect(result.ok && result.extension.grammars[0]!.grammarPath).toContain('demo.json')
  })

  it('skips a grammar whose file is absent', () => {
    writeManifest({
      ...BASE,
      contributes: { grammars: [{ scopeName: 'source.demo', path: './gone.json' }] }
    })
    const result = readVscodeExtension(root)
    expect(result.ok && result.extension.grammars).toEqual([])
    expect(result.ok && result.extension.problems.join(' ')).toMatch(/source.demo/)
  })

  it('loads snippets for a language', () => {
    writeFileSync(
      join(root, 'snippets.json'),
      JSON.stringify({ 'For Loop': { prefix: 'for', body: 'for $1 {\n\t$0\n}' } })
    )
    writeManifest({
      ...BASE,
      contributes: { snippets: [{ language: 'go', path: './snippets.json' }] }
    })
    const result = readVscodeExtension(root)
    expect(result.ok && result.extension.snippets).toEqual([
      {
        languageId: 'go',
        snippets: [
          {
            prefix: 'for',
            body: 'for $1 {\n\t$0\n}',
            name: 'For Loop',
            description: undefined,
            hasTabStops: true
          }
        ]
      }
    ])
  })

  it('reports skipped snippets but keeps the good ones', () => {
    writeFileSync(
      join(root, 'snippets.json'),
      JSON.stringify({ Good: { prefix: 'g', body: 'x' }, Bad: { prefix: 'b' } })
    )
    writeManifest({
      ...BASE,
      contributes: { snippets: [{ language: 'go', path: './snippets.json' }] }
    })
    const result = readVscodeExtension(root)
    expect(result.ok && result.extension.snippets[0]!.snippets).toHaveLength(1)
    expect(result.ok && result.extension.problems.join(' ')).toMatch(/Bad/)
  })
})

describe('readVscodeExtension commands and configuration', () => {
  it('loads commands', () => {
    writeManifest({
      ...BASE,
      contributes: {
        commands: [{ command: 'demo.run', title: 'Run Demo', category: 'Demo' }]
      }
    })
    const result = readVscodeExtension(root)
    expect(result.ok && result.extension.commands).toEqual([
      { command: 'demo.run', title: 'Run Demo', category: 'Demo' }
    ])
  })

  it('extracts configuration defaults and ignores the rest of the schema', () => {
    writeManifest({
      ...BASE,
      contributes: {
        configuration: {
          title: 'Demo',
          properties: {
            'demo.enabled': { type: 'boolean', default: true, description: 'ignored' },
            'demo.noDefault': { type: 'string' }
          }
        }
      }
    })
    const result = readVscodeExtension(root)
    expect(result.ok && result.extension.configurationDefaults).toEqual({
      'demo.enabled': true
    })
  })

  it('accepts configuration given as an array of sections', () => {
    writeManifest({
      ...BASE,
      contributes: {
        configuration: [
          { properties: { 'a.x': { default: 1 } } },
          { properties: { 'b.y': { default: 2 } } }
        ]
      }
    })
    const result = readVscodeExtension(root)
    expect(result.ok && result.extension.configurationDefaults).toEqual({ 'a.x': 1, 'b.y': 2 })
  })
})

describe('readVscodeExtension path safety', () => {
  it('refuses a manifest declaring a traversal theme path', () => {
    writeManifest({
      ...BASE,
      contributes: {
        themes: [{ label: 'Evil', uiTheme: 'vs-dark', path: '../outside/secret.txt' }]
      }
    })
    // Rejected by the manifest schema, before any file is opened.
    const result = readVscodeExtension(root)
    expect(result.ok).toBe(false)
  })

  it('refuses a symlinked snippet file pointing outside', () => {
    try {
      symlinkSync(join(outside, 'secret.txt'), join(root, 'snippets.json'))
    } catch {
      return
    }
    writeManifest({
      ...BASE,
      contributes: { snippets: [{ language: 'go', path: './snippets.json' }] }
    })
    const result = readVscodeExtension(root)
    expect(result.ok && result.extension.snippets).toEqual([])
    expect(result.ok && result.extension.problems.join(' ')).toMatch(/escapes/)
  })
})
