/**
 * Reads a VS Code extension from a directory on disk.
 *
 * Every read goes through `readContainedFile`, which resolves symlinks before
 * deciding: the manifest schema already rejects `../` in a declared path, but
 * a *symlink* inside the extension pointing at `~/.ssh/id_rsa` is a path that
 * passes textual validation and still escapes. Containment is therefore
 * checked against the real path, not the joined one.
 *
 * Nothing here throws for bad extension content. A missing theme file, an
 * unparseable snippet file or a broken language configuration is collected as
 * a problem and the rest of the extension still loads.
 */
import { join, resolve } from 'node:path'
import { containedFileExists, readContainedFile } from './contained-file-read'
import { parseJsonc } from '../../shared/vscode-compat/jsonc-parse'
import {
  parseVscodeManifest,
  vscodeExtensionId,
  type VscodeManifest
} from '../../shared/vscode-compat/vscode-manifest'
import {
  buildVscodeCompatibilityReport,
  type VscodeCompatibilityReport
} from '../../shared/vscode-compat/vscode-compatibility-report'
import {
  adaptVscodeTheme,
  monacoThemeId,
  type MonacoThemeData,
  type VscodeThemeType
} from '../../shared/vscode-compat/vscode-theme-adapter'
import {
  parseVscodeSnippetFile,
  type ParsedSnippet
} from '../../shared/vscode-compat/vscode-snippets'
import {
  adaptVscodeLanguageConfiguration,
  type MonacoLanguageConfiguration
} from '../../shared/vscode-compat/vscode-language-configuration'

export type LoadedTheme = {
  /** Monaco theme id, unique across extensions. */
  id: string
  label: string
  type: VscodeThemeType
  data: MonacoThemeData
}

export type LoadedGrammar = {
  scopeName: string
  /** Monaco language id this grammar tokenizes, when the manifest says. */
  languageId?: string
  /** Absolute path on disk; read lazily when the language is first opened. */
  grammarPath: string
  embeddedLanguages?: Record<string, string>
  injectTo?: string[]
}

export type LoadedLanguage = {
  id: string
  extensions: string[]
  aliases: string[]
  filenames: string[]
  firstLine?: string
  configuration?: MonacoLanguageConfiguration
}

export type LoadedSnippets = {
  languageId: string
  snippets: ParsedSnippet[]
}

export type LoadedCommand = { command: string; title: string; category?: string }

export type LoadedVscodeExtension = {
  extensionId: string
  /** Directory the extension was read from. */
  root: string
  manifest: VscodeManifest
  report: VscodeCompatibilityReport
  themes: LoadedTheme[]
  grammars: LoadedGrammar[]
  languages: LoadedLanguage[]
  snippets: LoadedSnippets[]
  commands: LoadedCommand[]
  configurationDefaults: Record<string, unknown>
  /** Non-fatal problems, for the install dialog and the extensions list. */
  problems: string[]
}

export type ReadVscodeExtensionResult =
  | { ok: true; extension: LoadedVscodeExtension }
  | { ok: false; error: string }

export function readVscodeExtension(root: string): ReadVscodeExtensionResult {
  const manifestFile = readContainedFile(root, 'package.json', 4 * 1024 * 1024)
  if (!manifestFile.ok) {
    return { ok: false, error: `package.json could not be read: ${manifestFile.error}` }
  }
  const json = parseJsonc(manifestFile.contents)
  if (!json.ok) {
    return { ok: false, error: `package.json is not valid JSON: ${json.error}` }
  }
  const parsed = parseVscodeManifest(json.value)
  if (!parsed.ok) {
    return { ok: false, error: parsed.error }
  }
  const manifest = parsed.manifest
  const extensionId = vscodeExtensionId(manifest)
  const problems: string[] = []

  return {
    ok: true,
    extension: {
      extensionId,
      root,
      manifest,
      report: buildVscodeCompatibilityReport(manifest, extensionId),
      themes: loadThemes(root, manifest, extensionId, problems),
      grammars: loadGrammars(root, manifest, problems),
      languages: loadLanguages(root, manifest, problems),
      snippets: loadSnippets(root, manifest, problems),
      commands: loadCommands(manifest),
      configurationDefaults: loadConfigurationDefaults(manifest),
      problems
    }
  }
}

function loadThemes(
  root: string,
  manifest: VscodeManifest,
  extensionId: string,
  problems: string[]
): LoadedTheme[] {
  const loaded: LoadedTheme[] = []
  for (const contribution of manifest.contributes?.themes ?? []) {
    const file = readContainedFile(root, contribution.path)
    if (!file.ok) {
      problems.push(`Theme "${contribution.label}" was skipped: ${file.error}.`)
      continue
    }
    const json = parseJsonc(file.contents)
    if (!json.ok) {
      problems.push(`Theme "${contribution.label}" is not valid JSON.`)
      continue
    }
    const adapted = adaptVscodeTheme(json.value, {
      uiTheme: contribution.uiTheme,
      fallbackName: contribution.label
    })
    if (!adapted.ok) {
      problems.push(`Theme "${contribution.label}" was skipped: ${adapted.error}.`)
      continue
    }
    for (const note of adapted.unsupportedFeatures) {
      problems.push(`Theme "${contribution.label}": ${note}`)
    }
    loaded.push({
      id: contribution.id ?? monacoThemeId(extensionId, contribution.label),
      label: contribution.label,
      type: adapted.type,
      data: adapted.theme
    })
  }
  return loaded
}

function loadGrammars(
  root: string,
  manifest: VscodeManifest,
  problems: string[]
): LoadedGrammar[] {
  const loaded: LoadedGrammar[] = []
  for (const contribution of manifest.contributes?.grammars ?? []) {
    // Only existence is checked here; the grammar body is read lazily by the
    // TextMate tokenizer the first time its language is opened.
    const probe = containedFileExists(root, contribution.path)
    if (!probe.ok) {
      problems.push(`Grammar for "${contribution.scopeName}" was skipped: ${probe.error}.`)
      continue
    }
    loaded.push({
      scopeName: contribution.scopeName,
      languageId: contribution.language,
      grammarPath: resolve(join(root, contribution.path)),
      embeddedLanguages: contribution.embeddedLanguages,
      injectTo: contribution.injectTo
    })
  }
  return loaded
}

function loadLanguages(
  root: string,
  manifest: VscodeManifest,
  problems: string[]
): LoadedLanguage[] {
  const loaded: LoadedLanguage[] = []
  for (const contribution of manifest.contributes?.languages ?? []) {
    let configuration: MonacoLanguageConfiguration | undefined
    if (contribution.configuration !== undefined) {
      const file = readContainedFile(root, contribution.configuration)
      if (!file.ok) {
        problems.push(
          `Language configuration for "${contribution.id}" was skipped: ${file.error}.`
        )
      } else {
        const json = parseJsonc(file.contents)
        if (!json.ok) {
          problems.push(`Language configuration for "${contribution.id}" is not valid JSON.`)
        } else {
          const adapted = adaptVscodeLanguageConfiguration(json.value)
          configuration = adapted.configuration
          for (const invalid of adapted.invalidPatterns) {
            problems.push(
              `Language "${contribution.id}": the ${invalid} pattern could not be compiled and was ignored.`
            )
          }
        }
      }
    }
    loaded.push({
      id: contribution.id,
      extensions: contribution.extensions ?? [],
      aliases: contribution.aliases ?? [],
      filenames: contribution.filenames ?? [],
      firstLine: contribution.firstLine,
      configuration
    })
  }
  return loaded
}

function loadSnippets(
  root: string,
  manifest: VscodeManifest,
  problems: string[]
): LoadedSnippets[] {
  const loaded: LoadedSnippets[] = []
  for (const contribution of manifest.contributes?.snippets ?? []) {
    const file = readContainedFile(root, contribution.path)
    if (!file.ok) {
      problems.push(
        `Snippets for "${contribution.language}" were skipped: ${file.error}.`
      )
      continue
    }
    const json = parseJsonc(file.contents)
    if (!json.ok) {
      problems.push(`Snippets for "${contribution.language}" are not valid JSON.`)
      continue
    }
    const parsed = parseVscodeSnippetFile(json.value)
    for (const skip of parsed.skipped) {
      problems.push(`Snippet "${skip.name}" (${contribution.language}): ${skip.reason}.`)
    }
    if (parsed.snippets.length > 0) {
      loaded.push({ languageId: contribution.language, snippets: parsed.snippets })
    }
  }
  return loaded
}

function loadCommands(manifest: VscodeManifest): LoadedCommand[] {
  return (manifest.contributes?.commands ?? []).map((contribution) => ({
    command: contribution.command,
    title: contribution.title,
    category: contribution.category
  }))
}

/** Reads only the `default` of each configuration property; the rest is UI schema. */
function loadConfigurationDefaults(manifest: VscodeManifest): Record<string, unknown> {
  const configuration = manifest.contributes?.configuration
  const sections = Array.isArray(configuration)
    ? configuration
    : configuration === undefined
      ? []
      : [configuration]
  const defaults: Record<string, unknown> = {}
  for (const section of sections) {
    for (const [key, schema] of Object.entries(section.properties ?? {})) {
      if (typeof schema === 'object' && schema !== null && 'default' in schema) {
        defaults[key] = (schema as { default: unknown }).default
      }
    }
  }
  return defaults
}
