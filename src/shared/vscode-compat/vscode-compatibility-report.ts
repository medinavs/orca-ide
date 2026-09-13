/**
 * What Orca will and will not do with a given VS Code extension.
 *
 * A first-class result rather than a boolean, because "incompatible" is almost
 * never the truth: a Go extension is a grammar Orca fully supports plus a
 * debugger it does not, and rejecting the whole thing would throw away the
 * part that works. So the report lists what loads, what is ignored, and why —
 * in words meant for the install dialog, not a log.
 */
import {
  SUPPORTED_VSCODE_CONTRIBUTIONS,
  vscodeExtensionDisplayName,
  type SupportedVscodeContribution,
  type VscodeManifest
} from './vscode-manifest'

export type VscodeSupportedSummary = {
  point: SupportedVscodeContribution
  count: number
}

export type VscodeUnsupportedReason = {
  /** The contribution point or capability, as VS Code names it. */
  feature: string
  /** Shown to the user verbatim. */
  explanation: string
}

export type VscodeCompatibilityReport = {
  extensionId: string
  displayName: string
  version: string
  /** True when at least one contribution point will actually load. */
  usable: boolean
  supported: VscodeSupportedSummary[]
  unsupported: VscodeUnsupportedReason[]
  /** One line for the install dialog's headline. */
  summary: string
}

/**
 * Contribution points Orca knowingly ignores, with the reason a user needs.
 *
 * Listed explicitly rather than lumped into "unsupported" so the message says
 * *what* will be missing. An extension whose whole purpose is a tree view
 * should say so before it is installed, not appear to work and then do nothing.
 */
const KNOWN_UNSUPPORTED: Record<string, string> = {
  debuggers: 'Debug adapters are not supported; debugging is unavailable.',
  breakpoints: 'Debug adapters are not supported.',
  views: 'Custom tree views are not supported. Orca panels come from Orca plugins.',
  viewsContainers: 'Custom view containers are not supported.',
  viewsWelcome: 'Custom view content is not supported.',
  menus: 'Menu contributions are not applied; commands appear in the palette instead.',
  keybindings: 'Extension keybindings are not applied; bind the command in Orca settings.',
  customEditors: 'Custom editors are not supported; files open in Orca’s editor.',
  notebooks: 'Notebook contributions are not supported.',
  notebookRenderer: 'Notebook renderers are not supported.',
  taskDefinitions: 'Task providers are not supported; use Orca terminals or automations.',
  problemMatchers: 'Problem matchers are not supported; diagnostics come from language servers.',
  problemPatterns: 'Problem matchers are not supported.',
  terminal: 'Terminal contributions are not supported.',
  walkthroughs: 'Walkthroughs are not supported.',
  iconThemes: 'File icon themes are not supported; Orca uses its own file icons.',
  productIconThemes: 'Product icon themes are not supported.',
  semanticTokenScopes: 'Semantic token theming is not supported.',
  jsonValidation: 'Bundled JSON schemas are not registered.',
  authentication: 'Authentication providers are not supported.',
  resourceLabelFormatters: 'Resource label formatters are not supported.',
  localizations: 'Extension localizations are not applied.'
}

function countContribution(
  manifest: VscodeManifest,
  point: SupportedVscodeContribution
): number {
  const contributes = manifest.contributes
  if (!contributes) {
    return 0
  }
  const value = (contributes as Record<string, unknown>)[point]
  if (Array.isArray(value)) {
    return value.length
  }
  // `configuration` may be a lone object rather than an array.
  return value === undefined || value === null ? 0 : 1
}

export function buildVscodeCompatibilityReport(
  manifest: VscodeManifest,
  extensionId: string
): VscodeCompatibilityReport {
  const supported: VscodeSupportedSummary[] = []
  for (const point of SUPPORTED_VSCODE_CONTRIBUTIONS) {
    const count = countContribution(manifest, point)
    if (count > 0) {
      supported.push({ point, count })
    }
  }

  const unsupported: VscodeUnsupportedReason[] = []
  const contributes = (manifest.contributes ?? {}) as Record<string, unknown>
  for (const key of Object.keys(contributes)) {
    if ((SUPPORTED_VSCODE_CONTRIBUTIONS as readonly string[]).includes(key)) {
      continue
    }
    unsupported.push({
      feature: key,
      explanation:
        KNOWN_UNSUPPORTED[key] ??
        `The "${key}" contribution point is not supported and was ignored.`
    })
  }

  // An entry point is the sharpest boundary: everything declarative works, but
  // nothing the extension's own code would do at runtime will happen.
  if (manifest.main !== undefined || manifest.browser !== undefined) {
    unsupported.push({
      feature: 'extension code',
      explanation:
        'This extension ships JavaScript that Orca does not run, so any behaviour it implements in code is unavailable. Themes, grammars, languages and snippets still load.'
    })
  }

  const usable = supported.length > 0
  return {
    extensionId,
    displayName: vscodeExtensionDisplayName(manifest),
    version: manifest.version,
    usable,
    supported,
    unsupported,
    summary: buildSummary(supported, usable)
  }
}

const POINT_LABELS: Record<SupportedVscodeContribution, [singular: string, plural: string]> = {
  languages: ['language', 'languages'],
  grammars: ['grammar', 'grammars'],
  themes: ['theme', 'themes'],
  snippets: ['snippet file', 'snippet files'],
  commands: ['command', 'commands'],
  configuration: ['configuration section', 'configuration sections']
}

function buildSummary(supported: VscodeSupportedSummary[], usable: boolean): string {
  if (!usable) {
    return 'Orca found nothing in this extension it can use.'
  }
  const parts = supported.map((entry) => {
    const [singular, plural] = POINT_LABELS[entry.point]
    return `${entry.count} ${entry.count === 1 ? singular : plural}`
  })
  const listed =
    parts.length === 1
      ? parts[0]!
      : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)!}`
  return `Orca will load ${listed}.`
}
