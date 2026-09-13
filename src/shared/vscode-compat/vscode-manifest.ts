/**
 * The subset of a VS Code extension `package.json` Orca understands.
 *
 * Parsed permissively and reported honestly: an extension is third-party input
 * Orca did not commission, so an unknown contribution point is *not* an error.
 * It is recorded as unsupported and everything supported still loads — which
 * is what makes a half-compatible extension useful rather than rejected.
 *
 * Every relative path goes through the same containment guard as Orca's own
 * plugin manifests (`isSafePluginRelativePath`), so a `../../` in a grammar
 * path is refused before anything reads it.
 */
import { z } from 'zod'
import { isSafePluginRelativePath } from '../plugins/plugin-path-safety'

export const VSCODE_CONTRIBUTION_LIMIT = 256

/**
 * Extension-relative paths, normalized then contained.
 *
 * The `./` prefix is stripped first because it is the conventional form in
 * every published VS Code manifest, while Orca's shared containment guard
 * rejects a `.` path segment outright. Normalizing before validating is what
 * lets the guard stay strict without failing ordinary extensions; the stored
 * value is canonical, so reads and hashing use one spelling.
 */
const relativePath = z
  .string()
  .min(1)
  .max(1024)
  .transform((value) => value.replace(/\\/g, '/').replace(/^(?:\.\/)+/, ''))
  .refine(isSafePluginRelativePath, 'must be a relative path inside the extension directory')

/** `contributes.languages` — a language id, its extensions and aliases. */
const languageContribution = z.object({
  id: z.string().min(1).max(128),
  extensions: z.array(z.string().min(1).max(64)).max(128).optional(),
  aliases: z.array(z.string().min(1).max(128)).max(32).optional(),
  filenames: z.array(z.string().min(1).max(256)).max(64).optional(),
  firstLine: z.string().max(1024).optional(),
  configuration: relativePath.optional(),
  mimetypes: z.array(z.string().min(1).max(128)).max(32).optional()
})

/** `contributes.grammars` — a TextMate grammar bound to a scope. */
const grammarContribution = z.object({
  language: z.string().min(1).max(128).optional(),
  scopeName: z.string().min(1).max(256),
  path: relativePath,
  /** Embedded scopes (`meta.embedded.block.css` → `css`). */
  embeddedLanguages: z.record(z.string(), z.string()).optional(),
  injectTo: z.array(z.string().min(1).max(256)).max(32).optional(),
  tokenTypes: z.record(z.string(), z.string()).optional()
})

/** `contributes.themes` — a color theme and whether it is light or dark. */
const themeContribution = z.object({
  id: z.string().min(1).max(128).optional(),
  label: z.string().min(1).max(256),
  uiTheme: z.string().min(1).max(64),
  path: relativePath
})

/** `contributes.snippets` — snippet definitions for one language. */
const snippetContribution = z.object({
  language: z.string().min(1).max(128),
  path: relativePath
})

/** `contributes.commands` — a command id and its palette title. */
const commandContribution = z.object({
  command: z.string().min(1).max(256),
  title: z.string().min(1).max(256),
  category: z.string().max(128).optional(),
  enablement: z.string().max(1024).optional()
})

/**
 * `contributes.configuration` — kept as an opaque record.
 *
 * VS Code's schema for this is large and mostly about rendering a settings UI;
 * Orca reads the property names and defaults and ignores the rest rather than
 * modelling a schema language it does not implement.
 */
const configurationContribution = z.object({
  title: z.string().max(256).optional(),
  properties: z.record(z.string(), z.unknown()).optional()
})

const contributes = z
  .object({
    languages: z.array(languageContribution).max(VSCODE_CONTRIBUTION_LIMIT).optional(),
    grammars: z.array(grammarContribution).max(VSCODE_CONTRIBUTION_LIMIT).optional(),
    themes: z.array(themeContribution).max(VSCODE_CONTRIBUTION_LIMIT).optional(),
    snippets: z.array(snippetContribution).max(VSCODE_CONTRIBUTION_LIMIT).optional(),
    commands: z.array(commandContribution).max(VSCODE_CONTRIBUTION_LIMIT).optional(),
    configuration: z
      .union([configurationContribution, z.array(configurationContribution)])
      .optional()
  })
  // Not `.strict()`: an extension contributing `debuggers` or `views` must
  // still load its themes. Unknown keys are reported, not rejected.
  .passthrough()

export const vscodeManifestSchema = z.object({
  name: z.string().min(1).max(256),
  version: z.string().min(1).max(64),
  publisher: z.string().min(1).max(256).optional(),
  displayName: z.string().max(256).optional(),
  description: z.string().max(4096).optional(),
  engines: z.record(z.string(), z.string()).optional(),
  categories: z.array(z.string().max(128)).max(32).optional(),
  /** Node entry point. Its presence means the extension wants to *run* code. */
  main: z.string().max(1024).optional(),
  browser: z.string().max(1024).optional(),
  activationEvents: z.array(z.string().max(256)).max(256).optional(),
  icon: z.string().max(1024).optional(),
  repository: z.unknown().optional(),
  contributes: contributes.optional()
})

export type VscodeManifest = z.infer<typeof vscodeManifestSchema>
export type VscodeLanguageContribution = z.infer<typeof languageContribution>
export type VscodeGrammarContribution = z.infer<typeof grammarContribution>
export type VscodeThemeContribution = z.infer<typeof themeContribution>
export type VscodeSnippetContribution = z.infer<typeof snippetContribution>
export type VscodeCommandContribution = z.infer<typeof commandContribution>

/** Contribution points Orca acts on. Everything else is reported unsupported. */
export const SUPPORTED_VSCODE_CONTRIBUTIONS = [
  'languages',
  'grammars',
  'themes',
  'snippets',
  'commands',
  'configuration'
] as const

export type SupportedVscodeContribution = (typeof SUPPORTED_VSCODE_CONTRIBUTIONS)[number]

export type VscodeManifestParseResult =
  | { ok: true; manifest: VscodeManifest }
  | { ok: false; error: string }

export function parseVscodeManifest(raw: unknown): VscodeManifestParseResult {
  const parsed = vscodeManifestSchema.safeParse(raw)
  if (parsed.success) {
    return { ok: true, manifest: parsed.data }
  }
  const issue = parsed.error.issues[0]
  const path = issue?.path.join('.') || '(root)'
  return { ok: false, error: `${path}: ${issue?.message ?? 'invalid extension manifest'}` }
}

/** `<publisher>.<name>`, matching VS Code's own extension identity. */
export function vscodeExtensionId(manifest: VscodeManifest): string {
  return manifest.publisher === undefined
    ? manifest.name
    : `${manifest.publisher}.${manifest.name}`
}

export function vscodeExtensionDisplayName(manifest: VscodeManifest): string {
  return manifest.displayName ?? manifest.name
}
