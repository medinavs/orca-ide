/**
 * Installed VS Code-compatible extensions on disk.
 *
 * Deliberately separate from Orca's own plugin store: an Orca plugin is
 * consented, capability-gated and may run a worker, while these contribute
 * only declarative data (themes, grammars, snippets, language configuration).
 * Mixing them would either over-prompt for a color theme or under-prompt for a
 * plugin, and the consent model is the part that must not blur.
 *
 * Layout, one directory per extension, named by its id:
 *
 *   <userData>/vscode-extensions/
 *     golang.go-0.42.0/
 *     dracula-theme.theme-dracula-2.24.3/
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  readVscodeExtension,
  type LoadedVscodeExtension
} from './vscode-extension-reader'

export const VSCODE_EXTENSIONS_DIRNAME = 'vscode-extensions'
/** A guard on install size, not a product limit. */
export const MAX_INSTALLED_VSCODE_EXTENSIONS = 200

export type InstalledVscodeExtension = {
  extensionId: string
  displayName: string
  version: string
  /** Directory name under the extensions root. */
  installDir: string
  enabled: boolean
  themes: { id: string; label: string; type: string }[]
  languages: string[]
  grammarScopes: string[]
  snippetLanguages: string[]
  commands: { command: string; title: string }[]
  problems: string[]
  /** Why parts of it are not active, in words for the extensions list. */
  unsupported: { feature: string; explanation: string }[]
  summary: string
}

export type VscodeExtensionStoreOptions = {
  /** Root that holds one directory per installed extension. */
  root: string
  /** Disabled extension ids; owned by settings, passed in. */
  isEnabled?: (extensionId: string) => boolean
}

export type VscodeInstallResult =
  | { ok: true; extension: InstalledVscodeExtension }
  | { ok: false; error: string }

function toInstalled(
  loaded: LoadedVscodeExtension,
  installDir: string,
  enabled: boolean
): InstalledVscodeExtension {
  return {
    extensionId: loaded.extensionId,
    displayName: loaded.report.displayName,
    version: loaded.manifest.version,
    installDir,
    enabled,
    themes: loaded.themes.map((theme) => ({
      id: theme.id,
      label: theme.label,
      type: theme.type
    })),
    languages: loaded.languages.map((language) => language.id),
    grammarScopes: loaded.grammars.map((grammar) => grammar.scopeName),
    snippetLanguages: loaded.snippets.map((entry) => entry.languageId),
    commands: loaded.commands.map((command) => ({
      command: command.command,
      title: command.title
    })),
    problems: loaded.problems,
    unsupported: loaded.report.unsupported,
    summary: loaded.report.summary
  }
}

export type VscodeExtensionStore = {
  /** Reads every installed extension, skipping unreadable directories. */
  list(): InstalledVscodeExtension[]
  /** Fully loads the enabled extensions, for registering contributions. */
  loadEnabled(): LoadedVscodeExtension[]
  /** Copies an extension directory into the store. */
  installFromDirectory(source: string): VscodeInstallResult
  remove(extensionId: string): boolean
  /** Directory holding one extension, or null when it is not installed. */
  directoryFor(extensionId: string): string | null
}

export function createVscodeExtensionStore(
  options: VscodeExtensionStoreOptions
): VscodeExtensionStore {
  const isEnabled = options.isEnabled ?? ((): boolean => true)

  function ensureRoot(): void {
    mkdirSync(options.root, { recursive: true })
  }

  function installedDirectories(): string[] {
    if (!existsSync(options.root)) {
      return []
    }
    try {
      return readdirSync(options.root).filter((entry) => {
        try {
          return statSync(join(options.root, entry)).isDirectory()
        } catch {
          return false
        }
      })
    } catch {
      return []
    }
  }

  /** Loads every installed extension once; callers project what they need. */
  function readAll(): { loaded: LoadedVscodeExtension; installDir: string }[] {
    const results: { loaded: LoadedVscodeExtension; installDir: string }[] = []
    for (const installDir of installedDirectories()) {
      const result = readVscodeExtension(join(options.root, installDir))
      if (result.ok) {
        results.push({ loaded: result.extension, installDir })
      }
      // An unreadable directory is skipped rather than failing the list: one
      // corrupt install must not hide every other extension.
    }
    return results
  }

  return {
    list: () =>
      readAll().map(({ loaded, installDir }) =>
        toInstalled(loaded, installDir, isEnabled(loaded.extensionId))
      ),

    loadEnabled: () =>
      readAll()
        .filter(({ loaded }) => isEnabled(loaded.extensionId))
        .map(({ loaded }) => loaded),

    installFromDirectory(source) {
      const probe = readVscodeExtension(source)
      if (!probe.ok) {
        return { ok: false, error: probe.error }
      }
      if (!probe.extension.report.usable) {
        // Refused with the report's own words rather than a generic failure.
        return { ok: false, error: probe.extension.report.summary }
      }
      if (installedDirectories().length >= MAX_INSTALLED_VSCODE_EXTENSIONS) {
        return {
          ok: false,
          error: `Orca holds at most ${MAX_INSTALLED_VSCODE_EXTENSIONS} extensions; remove one first.`
        }
      }
      const installDir = `${probe.extension.extensionId}-${probe.extension.manifest.version}`
      const target = join(options.root, installDir)
      ensureRoot()
      try {
        // Replaced wholesale so reinstalling a version cannot leave a mix of
        // old and new files behind.
        rmSync(target, { recursive: true, force: true })
        cpSync(source, target, { recursive: true, dereference: true })
      } catch (error) {
        return { ok: false, error: `could not copy the extension: ${String(error)}` }
      }
      const installed = readVscodeExtension(target)
      if (!installed.ok) {
        rmSync(target, { recursive: true, force: true })
        return { ok: false, error: installed.error }
      }
      return {
        ok: true,
        extension: toInstalled(
          installed.extension,
          installDir,
          isEnabled(installed.extension.extensionId)
        )
      }
    },

    remove(extensionId) {
      let removed = false
      for (const { loaded, installDir } of readAll()) {
        if (loaded.extensionId !== extensionId) {
          continue
        }
        try {
          rmSync(join(options.root, installDir), { recursive: true, force: true })
          removed = true
        } catch {
          /* leave `removed` false so the caller can report the failure */
        }
      }
      return removed
    },

    directoryFor(extensionId) {
      const match = readAll().find(({ loaded }) => loaded.extensionId === extensionId)
      return match === undefined ? null : join(options.root, match.installDir)
    }
  }
}
