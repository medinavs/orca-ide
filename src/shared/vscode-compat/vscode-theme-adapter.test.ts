import { describe, expect, it } from 'vitest'
import {
  adaptVscodeTheme,
  monacoThemeId,
  toMonacoTokenColor,
  vscodeThemeType
} from './vscode-theme-adapter'

describe('toMonacoTokenColor', () => {
  it('strips the leading hash, which Monaco token rules reject', () => {
    expect(toMonacoTokenColor('#ff0000')).toBe('ff0000')
    expect(toMonacoTokenColor('ff0000')).toBe('ff0000')
  })

  it('expands 3-digit shorthand', () => {
    expect(toMonacoTokenColor('#f0a')).toBe('ff00aa')
  })

  it('drops alpha rather than passing a form Monaco silently ignores', () => {
    // Monaco rejects 8-digit colors outright, which loses the whole rule —
    // approximating without alpha keeps the token colored.
    expect(toMonacoTokenColor('#ff0000cc')).toBe('ff0000')
    expect(toMonacoTokenColor('#f0ac')).toBe('ff00aa')
  })

  it('rejects a non-hex value', () => {
    expect(toMonacoTokenColor('red')).toBeNull()
    expect(toMonacoTokenColor('rgb(1,2,3)')).toBeNull()
    expect(toMonacoTokenColor('#12345')).toBeNull()
    expect(toMonacoTokenColor(undefined)).toBeNull()
  })

  it('tolerates surrounding whitespace', () => {
    expect(toMonacoTokenColor('  #ff0000 ')).toBe('ff0000')
  })
})

describe('vscodeThemeType', () => {
  it('uses the declared type', () => {
    expect(vscodeThemeType({ type: 'light' })).toBe('light')
    expect(vscodeThemeType({ type: 'dark' })).toBe('dark')
  })

  it('normalizes the high-contrast spellings', () => {
    expect(vscodeThemeType({ type: 'hc' })).toBe('hc-dark')
    expect(vscodeThemeType({ type: 'hc-dark' })).toBe('hc-dark')
    expect(vscodeThemeType({ type: 'hc-light' })).toBe('hc-light')
  })

  it('falls back to the manifest uiTheme when the file omits type', () => {
    // `type` is optional in the theme file but `uiTheme` is required in the
    // manifest, so it is the reliable signal.
    expect(vscodeThemeType({}, 'vs')).toBe('light')
    expect(vscodeThemeType({}, 'vs-dark')).toBe('dark')
    expect(vscodeThemeType({}, 'hc-black')).toBe('hc-dark')
  })

  it('defaults to dark when neither says', () => {
    expect(vscodeThemeType({})).toBe('dark')
  })
})

describe('adaptVscodeTheme', () => {
  it('maps the theme type onto a Monaco base', () => {
    expect(adaptVscodeTheme({ type: 'light' })).toMatchObject({
      ok: true,
      theme: { base: 'vs', inherit: true }
    })
    expect(adaptVscodeTheme({ type: 'dark' })).toMatchObject({ theme: { base: 'vs-dark' } })
    expect(adaptVscodeTheme({ type: 'hc' })).toMatchObject({ theme: { base: 'hc-black' } })
  })

  it('converts token colors', () => {
    const result = adaptVscodeTheme({
      type: 'dark',
      tokenColors: [
        { scope: 'comment', settings: { foreground: '#6A9955', fontStyle: 'italic' } }
      ]
    })
    expect(result.ok && result.theme.rules).toEqual([
      { token: 'comment', foreground: '6A9955', fontStyle: 'italic' }
    ])
  })

  it('expands an array of scopes into one rule each', () => {
    const result = adaptVscodeTheme({
      tokenColors: [
        { scope: ['keyword', 'storage.type'], settings: { foreground: '#569CD6' } }
      ]
    })
    expect(result.ok && result.theme.rules.map((rule) => rule.token)).toEqual([
      'keyword',
      'storage.type'
    ])
  })

  it('splits the comma-separated scope form published themes use', () => {
    const result = adaptVscodeTheme({
      tokenColors: [{ scope: 'keyword, storage.type ', settings: { foreground: '#569CD6' } }]
    })
    expect(result.ok && result.theme.rules.map((rule) => rule.token)).toEqual([
      'keyword',
      'storage.type'
    ])
  })

  it('treats a scope-less entry as the default text rule', () => {
    const result = adaptVscodeTheme({ tokenColors: [{ settings: { foreground: '#d4d4d4' } }] })
    expect(result.ok && result.theme.rules).toEqual([{ token: '', foreground: 'd4d4d4' }])
  })

  it('keeps only font styles Monaco renders', () => {
    const result = adaptVscodeTheme({
      tokenColors: [
        { scope: 'a', settings: { foreground: '#fff', fontStyle: 'italic bold nonsense' } }
      ]
    })
    expect(result.ok && result.theme.rules[0]!.fontStyle).toBe('italic bold')
  })

  it('drops an entry with nothing usable', () => {
    const result = adaptVscodeTheme({
      tokenColors: [{ scope: 'a', settings: {} }, { scope: 'b' }]
    })
    expect(result.ok && result.theme.rules).toEqual([])
  })

  it('keeps editor colors with the hash and expands shorthand', () => {
    const result = adaptVscodeTheme({
      colors: { 'editor.background': '#1e1e1e', 'editor.foreground': '#ccc' }
    })
    expect(result.ok && result.theme.colors).toEqual({
      'editor.background': '#1e1e1e',
      'editor.foreground': '#cccccc'
    })
  })

  it('reports colors it had to drop rather than silently losing them', () => {
    const result = adaptVscodeTheme({
      colors: { 'editor.background': 'not-a-color', 'editor.foreground': '#fff' }
    })
    expect(result.ok && result.theme.colors).toEqual({ 'editor.foreground': '#ffffff' })
    expect(result.ok && result.unsupportedFeatures.join(' ')).toMatch(/1 color value/)
  })

  it('reports an include it will not follow', () => {
    const result = adaptVscodeTheme({ include: './base.json' })
    expect(result.ok && result.unsupportedFeatures.join(' ')).toMatch(/extends another file/)
  })

  it('reports token colors stored in a separate file', () => {
    const result = adaptVscodeTheme({ tokenColors: './tokens.json' })
    expect(result.ok && result.unsupportedFeatures.join(' ')).toMatch(/separate file/)
    expect(result.ok && result.theme.rules).toEqual([])
  })

  it('reports semantic highlighting as unapplied', () => {
    const result = adaptVscodeTheme({ semanticHighlighting: true })
    expect(result.ok && result.unsupportedFeatures.join(' ')).toMatch(/Semantic highlighting/)
  })

  it('names the theme, falling back when it has none', () => {
    expect(adaptVscodeTheme({ name: 'Dracula' })).toMatchObject({ name: 'Dracula' })
    expect(adaptVscodeTheme({}, { fallbackName: 'From manifest' })).toMatchObject({
      name: 'From manifest'
    })
  })

  it('rejects a non-object theme file', () => {
    expect(adaptVscodeTheme('nope')).toEqual({
      ok: false,
      error: 'theme file must contain a JSON object'
    })
    expect(adaptVscodeTheme(null).ok).toBe(false)
    expect(adaptVscodeTheme([]).ok).toBe(false)
  })

  it('succeeds on an empty theme rather than failing', () => {
    // A theme with no colors is useless but not malformed; it inherits.
    const result = adaptVscodeTheme({ type: 'dark' })
    expect(result.ok).toBe(true)
    expect(result.ok && result.theme.rules).toEqual([])
  })

  it('survives a malformed tokenColors entry', () => {
    const result = adaptVscodeTheme({
      tokenColors: [null, 'nonsense', { scope: 'a', settings: { foreground: '#fff' } }]
    })
    expect(result.ok && result.theme.rules).toHaveLength(1)
  })
})

describe('monacoThemeId', () => {
  it('builds a collision-resistant id from the extension and label', () => {
    expect(monacoThemeId('dracula-theme.theme-dracula', 'Dracula')).toBe(
      'vscode-dracula-theme-theme-dracula-dracula'
    )
  })

  it('differs for two themes in the same extension', () => {
    expect(monacoThemeId('a.b', 'Light')).not.toBe(monacoThemeId('a.b', 'Dark'))
  })

  it('collapses punctuation and trims separators', () => {
    expect(monacoThemeId('x', '  Solarized (Light)!  ')).toBe('vscode-x-solarized-light')
  })

  it('never produces an empty id', () => {
    expect(monacoThemeId('', '###')).toBe('vscode-theme')
  })
})
