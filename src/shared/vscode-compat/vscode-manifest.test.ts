import { describe, expect, it } from 'vitest'
import {
  parseVscodeManifest,
  vscodeExtensionDisplayName,
  vscodeExtensionId
} from './vscode-manifest'
import { buildVscodeCompatibilityReport } from './vscode-compatibility-report'

const MINIMAL = { name: 'go', version: '0.42.0', publisher: 'golang' }

describe('parseVscodeManifest', () => {
  it('accepts a minimal manifest', () => {
    const result = parseVscodeManifest(MINIMAL)
    expect(result.ok).toBe(true)
    expect(result.ok && vscodeExtensionId(result.manifest)).toBe('golang.go')
  })

  it('falls back to the bare name when there is no publisher', () => {
    const result = parseVscodeManifest({ name: 'local-thing', version: '1.0.0' })
    expect(result.ok && vscodeExtensionId(result.manifest)).toBe('local-thing')
  })

  it('prefers displayName for presentation', () => {
    const result = parseVscodeManifest({ ...MINIMAL, displayName: 'Go' })
    expect(result.ok && vscodeExtensionDisplayName(result.manifest)).toBe('Go')
    const bare = parseVscodeManifest(MINIMAL)
    expect(bare.ok && vscodeExtensionDisplayName(bare.manifest)).toBe('go')
  })

  it('rejects a manifest with no name or version', () => {
    expect(parseVscodeManifest({ version: '1.0.0' }).ok).toBe(false)
    expect(parseVscodeManifest({ name: 'x' }).ok).toBe(false)
    expect(parseVscodeManifest(null).ok).toBe(false)
    expect(parseVscodeManifest('not an object').ok).toBe(false)
  })

  it('names the offending field in the error', () => {
    const result = parseVscodeManifest({ name: '', version: '1.0.0' })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('name')
  })

  it('keeps unknown contribution points instead of rejecting the manifest', () => {
    // A Go extension is a grammar Orca supports plus a debugger it does not;
    // rejecting the whole manifest would discard the part that works.
    const result = parseVscodeManifest({
      ...MINIMAL,
      contributes: {
        grammars: [{ scopeName: 'source.go', path: './syntaxes/go.json' }],
        debuggers: [{ type: 'go' }]
      }
    })
    expect(result.ok).toBe(true)
    expect(result.ok && result.manifest.contributes?.grammars).toHaveLength(1)
  })

  it('accepts configuration as a lone object or an array', () => {
    expect(
      parseVscodeManifest({ ...MINIMAL, contributes: { configuration: { title: 'Go' } } }).ok
    ).toBe(true)
    expect(
      parseVscodeManifest({ ...MINIMAL, contributes: { configuration: [{ title: 'Go' }] } }).ok
    ).toBe(true)
  })
})

describe('parseVscodeManifest path safety', () => {
  it('refuses a grammar path escaping the extension directory', () => {
    const result = parseVscodeManifest({
      ...MINIMAL,
      contributes: {
        grammars: [{ scopeName: 'source.go', path: '../../../etc/passwd' }]
      }
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('relative path')
  })

  it('refuses an absolute theme path', () => {
    expect(
      parseVscodeManifest({
        ...MINIMAL,
        contributes: { themes: [{ label: 'T', uiTheme: 'vs-dark', path: '/etc/theme.json' }] }
      }).ok
    ).toBe(false)
  })

  it('refuses a Windows device name as a snippet path', () => {
    expect(
      parseVscodeManifest({
        ...MINIMAL,
        contributes: { snippets: [{ language: 'go', path: 'NUL' }] }
      }).ok
    ).toBe(false)
  })

  it('accepts the conventional ./-prefixed relative path', () => {
    expect(
      parseVscodeManifest({
        ...MINIMAL,
        contributes: { themes: [{ label: 'T', uiTheme: 'vs-dark', path: './themes/dark.json' }] }
      }).ok
    ).toBe(true)
  })
})

describe('buildVscodeCompatibilityReport', () => {
  it('lists what will load', () => {
    const parsed = parseVscodeManifest({
      ...MINIMAL,
      contributes: {
        languages: [{ id: 'go', extensions: ['.go'] }],
        grammars: [{ scopeName: 'source.go', path: './go.json' }],
        themes: [
          { label: 'A', uiTheme: 'vs-dark', path: './a.json' },
          { label: 'B', uiTheme: 'vs', path: './b.json' }
        ]
      }
    })
    const report = buildVscodeCompatibilityReport(
      parsed.ok ? parsed.manifest : MINIMAL,
      'golang.go'
    )
    expect(report.usable).toBe(true)
    expect(report.supported).toEqual([
      { point: 'languages', count: 1 },
      { point: 'grammars', count: 1 },
      { point: 'themes', count: 2 }
    ])
    expect(report.summary).toBe('Orca will load 1 language, 1 grammar and 2 themes.')
  })

  it('pluralizes a single contribution correctly', () => {
    const parsed = parseVscodeManifest({
      ...MINIMAL,
      contributes: { themes: [{ label: 'A', uiTheme: 'vs-dark', path: './a.json' }] }
    })
    const report = buildVscodeCompatibilityReport(parsed.ok ? parsed.manifest : MINIMAL, 'x')
    expect(report.summary).toBe('Orca will load 1 theme.')
  })

  it('explains a known unsupported contribution in the user words', () => {
    const parsed = parseVscodeManifest({
      ...MINIMAL,
      contributes: {
        themes: [{ label: 'A', uiTheme: 'vs-dark', path: './a.json' }],
        debuggers: [{ type: 'go' }],
        views: {}
      }
    })
    const report = buildVscodeCompatibilityReport(parsed.ok ? parsed.manifest : MINIMAL, 'x')
    const features = report.unsupported.map((entry) => entry.feature)
    expect(features).toEqual(expect.arrayContaining(['debuggers', 'views']))
    expect(
      report.unsupported.find((entry) => entry.feature === 'debuggers')?.explanation
    ).toMatch(/Debug adapters/)
  })

  it('falls back to a generic explanation for an unrecognised point', () => {
    const parsed = parseVscodeManifest({
      ...MINIMAL,
      contributes: { somethingBrandNew: [{}] }
    })
    const report = buildVscodeCompatibilityReport(parsed.ok ? parsed.manifest : MINIMAL, 'x')
    expect(report.unsupported[0]).toMatchObject({
      feature: 'somethingBrandNew',
      explanation: expect.stringContaining('not supported')
    })
  })

  it('warns plainly when the extension ships code Orca will not run', () => {
    const parsed = parseVscodeManifest({
      ...MINIMAL,
      main: './out/extension.js',
      contributes: { themes: [{ label: 'A', uiTheme: 'vs-dark', path: './a.json' }] }
    })
    const report = buildVscodeCompatibilityReport(parsed.ok ? parsed.manifest : MINIMAL, 'x')
    const code = report.unsupported.find((entry) => entry.feature === 'extension code')
    expect(code?.explanation).toMatch(/does not run/)
    // Still usable: the theme loads even though the code does not.
    expect(report.usable).toBe(true)
  })

  it('reports an extension with nothing usable as unusable', () => {
    const parsed = parseVscodeManifest({
      ...MINIMAL,
      main: './out/extension.js',
      contributes: { debuggers: [{ type: 'go' }] }
    })
    const report = buildVscodeCompatibilityReport(parsed.ok ? parsed.manifest : MINIMAL, 'x')
    expect(report.usable).toBe(false)
    expect(report.summary).toBe('Orca found nothing in this extension it can use.')
  })

  it('reports an extension with no contributes at all as unusable', () => {
    const report = buildVscodeCompatibilityReport(MINIMAL, 'x')
    expect(report.usable).toBe(false)
    expect(report.unsupported).toEqual([])
  })
})
