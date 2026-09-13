/**
 * VS Code color theme JSON → a Monaco theme.
 *
 *   VS Code theme JSON → this adapter → monaco.editor.defineTheme → editor
 *
 * Built the same way as the Warp/Ghostty terminal importer
 * (`terminal-custom-themes.ts`): translate what maps cleanly, report what does
 * not in an `unsupportedFeatures` list, and never fail the whole theme over one
 * property Orca has no surface for.
 *
 * Two things a naive adapter gets wrong, both handled here:
 *
 * - Monaco wants token colors as hex **without** the `#`, and rejects the
 *   8-digit `#RRGGBBAA` form VS Code allows. Alpha is dropped rather than
 *   passed through, because passing it through makes Monaco ignore the rule
 *   entirely and the token silently loses its color.
 * - `tokenColors` may be a string (a path to another file) in some themes;
 *   that is an include Orca does not follow, and it is reported.
 */

export type VscodeThemeType = 'dark' | 'light' | 'hc-dark' | 'hc-light'

export type VscodeTokenColor = {
  name?: string
  /** One scope or several; VS Code allows both spellings. */
  scope?: string | string[]
  settings?: {
    foreground?: string
    background?: string
    fontStyle?: string
  }
}

export type VscodeThemeDocument = {
  name?: string
  type?: string
  include?: string
  colors?: Record<string, string>
  tokenColors?: VscodeTokenColor[] | string
  semanticHighlighting?: boolean
  semanticTokenColors?: Record<string, unknown>
}

export type MonacoTokenRule = {
  token: string
  foreground?: string
  background?: string
  fontStyle?: string
}

export type MonacoThemeData = {
  base: 'vs' | 'vs-dark' | 'hc-black' | 'hc-light'
  inherit: boolean
  rules: MonacoTokenRule[]
  colors: Record<string, string>
}

export type VscodeThemeAdaptResult =
  | {
      ok: true
      theme: MonacoThemeData
      name: string
      type: VscodeThemeType
      /** Properties Orca recognised but cannot honour, in user-facing words. */
      unsupportedFeatures: string[]
    }
  | { ok: false; error: string }

/** `#RRGGBB`, `#RGB`, or the 8-digit form whose alpha Monaco cannot use. */
const HEX_WITH_OPTIONAL_ALPHA = /^#?([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

/**
 * Normalizes a VS Code color to what Monaco's token rules accept: bare hex,
 * six digits, no alpha. Returns null for anything unusable.
 */
export function toMonacoTokenColor(value: string | undefined): string | null {
  if (typeof value !== 'string' || !HEX_WITH_OPTIONAL_ALPHA.test(value.trim())) {
    return null
  }
  const hex = value.trim().replace(/^#/, '')
  if (hex.length === 3 || hex.length === 4) {
    // Expand shorthand; a 4th digit is alpha and is dropped.
    return hex
      .slice(0, 3)
      .split('')
      .map((digit) => `${digit}${digit}`)
      .join('')
  }
  // 8-digit form: keep RGB, drop AA. Monaco rejects the alpha form outright,
  // which would lose the rule rather than approximate it.
  return hex.slice(0, 6)
}

/** Editor colors keep the `#` and may keep alpha — Monaco accepts both here. */
function toMonacoEditorColor(value: string | undefined): string | null {
  if (typeof value !== 'string' || !HEX_WITH_OPTIONAL_ALPHA.test(value.trim())) {
    return null
  }
  const hex = value.trim().replace(/^#/, '')
  const expanded =
    hex.length === 3 || hex.length === 4
      ? hex
          .split('')
          .map((digit) => `${digit}${digit}`)
          .join('')
      : hex
  return `#${expanded}`
}

export function vscodeThemeType(document: VscodeThemeDocument, uiTheme?: string): VscodeThemeType {
  const declared = (document.type ?? '').toLowerCase()
  if (declared === 'light' || declared === 'dark' || declared === 'hc-light') {
    return declared as VscodeThemeType
  }
  if (declared === 'hc' || declared === 'hcdark' || declared === 'hc-dark') {
    return 'hc-dark'
  }
  // Fall back to the manifest's `uiTheme`, which is required there even when
  // the theme file itself omits `type`. A lookup rather than a switch so the
  // absent case is one of the data, not a `default` that hides it.
  const byUiTheme: Record<string, VscodeThemeType> = {
    vs: 'light',
    'vs-dark': 'dark',
    'hc-black': 'hc-dark',
    'hc-light': 'hc-light'
  }
  return (uiTheme === undefined ? undefined : byUiTheme[uiTheme]) ?? 'dark'
}

const BASE_BY_TYPE: Record<VscodeThemeType, MonacoThemeData['base']> = {
  dark: 'vs-dark',
  light: 'vs',
  'hc-dark': 'hc-black',
  'hc-light': 'hc-light'
}

function normalizeScopes(scope: VscodeTokenColor['scope']): string[] {
  if (typeof scope === 'string') {
    // A comma-separated list is legal and common in published themes.
    return scope
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '')
  }
  if (Array.isArray(scope)) {
    return scope.filter((entry) => typeof entry === 'string' && entry.trim() !== '')
  }
  return []
}

/** Only the styles Monaco renders; `underline`/`strikethrough` pass through. */
const ALLOWED_FONT_STYLES = new Set(['italic', 'bold', 'underline', 'strikethrough'])

function normalizeFontStyle(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const styles = value
    .split(/\s+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => ALLOWED_FONT_STYLES.has(entry))
  return styles.length > 0 ? styles.join(' ') : undefined
}

export function adaptVscodeTheme(
  raw: unknown,
  options: { uiTheme?: string; fallbackName?: string } = {}
): VscodeThemeAdaptResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'theme file must contain a JSON object' }
  }
  const document = raw as VscodeThemeDocument
  const unsupportedFeatures: string[] = []
  const type = vscodeThemeType(document, options.uiTheme)

  if (typeof document.include === 'string') {
    unsupportedFeatures.push(
      `This theme extends another file ("${document.include}"), which Orca does not follow, so some colors may be missing.`
    )
  }
  if (typeof document.tokenColors === 'string') {
    unsupportedFeatures.push(
      'This theme loads its token colors from a separate file, which Orca does not follow.'
    )
  }
  if (document.semanticTokenColors !== undefined || document.semanticHighlighting === true) {
    unsupportedFeatures.push(
      'Semantic highlighting colors are not applied; Orca colors code from the grammar.'
    )
  }

  const rules: MonacoTokenRule[] = []
  const tokenColors = Array.isArray(document.tokenColors) ? document.tokenColors : []
  for (const entry of tokenColors) {
    if (typeof entry !== 'object' || entry === null) {
      continue
    }
    const foreground = toMonacoTokenColor(entry.settings?.foreground)
    const background = toMonacoTokenColor(entry.settings?.background)
    const fontStyle = normalizeFontStyle(entry.settings?.fontStyle)
    if (foreground === null && background === null && fontStyle === undefined) {
      continue
    }
    const scopes = normalizeScopes(entry.scope)
    // An entry with no scope is VS Code's default-text rule; Monaco spells
    // that as the empty token.
    for (const token of scopes.length > 0 ? scopes : ['']) {
      rules.push({
        token,
        ...(foreground === null ? {} : { foreground }),
        ...(background === null ? {} : { background }),
        ...(fontStyle === undefined ? {} : { fontStyle })
      })
    }
  }

  const colors: Record<string, string> = {}
  let droppedColors = 0
  for (const [key, value] of Object.entries(document.colors ?? {})) {
    const color = toMonacoEditorColor(value)
    if (color === null) {
      // A named color reference or a non-hex value; Monaco takes hex only.
      droppedColors += 1
      continue
    }
    colors[key] = color
  }
  if (droppedColors > 0) {
    unsupportedFeatures.push(
      `${droppedColors} color value${droppedColors === 1 ? '' : 's'} used a format Monaco cannot read and kept the default.`
    )
  }

  return {
    ok: true,
    theme: { base: BASE_BY_TYPE[type], inherit: true, rules, colors },
    name: document.name ?? options.fallbackName ?? 'Imported theme',
    type,
    unsupportedFeatures
  }
}

/** A Monaco theme id that cannot collide with a built-in or another extension. */
export function monacoThemeId(extensionId: string, label: string): string {
  const slug = `${extensionId}-${label}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96)
  return `vscode-${slug || 'theme'}`
}
