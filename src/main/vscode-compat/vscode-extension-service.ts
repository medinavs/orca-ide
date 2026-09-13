/**
 * The main-process facade for VS Code-compatible extensions.
 *
 * Owns the store, the enable/disable set, and the projection the renderer
 * needs to register contributions in Monaco. Grammar *bodies* are served on
 * request rather than pushed: a grammar is a large file the tokenizer only
 * needs when its language is first opened.
 */
import { join } from 'node:path'
import { readContainedFile } from './contained-file-read'
import {
  createVscodeExtensionStore,
  VSCODE_EXTENSIONS_DIRNAME,
  type InstalledVscodeExtension,
  type VscodeExtensionStore
} from './vscode-extension-store'
import { installVsixFile, type VsixInstallResult } from './vsix-install'
import type { LoadedVscodeExtension } from './vscode-extension-reader'
import type { VscodeContributionBundle } from '../../shared/vscode-compat/vscode-extension-types'
export type { VscodeContributionBundle } from '../../shared/vscode-compat/vscode-extension-types'

/** Everything the renderer needs to register one enabled extension. */
export type VscodeExtensionServiceOptions = {
  /** Usually `app.getPath('userData')`. */
  userDataPath: string
  /** Disabled ids come from settings; the service does not own them. */
  disabledExtensionIds?: () => readonly string[]
  onChanged?: () => void
}

export type VscodeExtensionService = {
  list(): InstalledVscodeExtension[]
  contributions(): VscodeContributionBundle
  installFromVsix(archivePath: string): VsixInstallResult
  installFromDirectory(directory: string): VsixInstallResult
  remove(extensionId: string): boolean
  /** Raw grammar JSON, read on demand and containment-checked. */
  readGrammar(
    extensionId: string,
    scopeName: string
  ): { ok: true; contents: string } | { ok: false; error: string }
  extensionsRoot(): string
}

export function createVscodeExtensionService(
  options: VscodeExtensionServiceOptions
): VscodeExtensionService {
  const root = join(options.userDataPath, VSCODE_EXTENSIONS_DIRNAME)
  const disabled = (): ReadonlySet<string> => new Set(options.disabledExtensionIds?.() ?? [])
  const store: VscodeExtensionStore = createVscodeExtensionStore({
    root,
    isEnabled: (extensionId) => !disabled().has(extensionId)
  })

  function announce<T>(result: T): T {
    options.onChanged?.()
    return result
  }

  function loadedGrammarPath(extensionId: string, scopeName: string): string | null {
    const extension = store.loadEnabled().find((candidate) => candidate.extensionId === extensionId)
    const grammar = extension?.grammars.find((entry) => entry.scopeName === scopeName)
    return grammar?.grammarPath ?? null
  }

  return {
    list: () => store.list(),

    contributions(): VscodeContributionBundle {
      const bundle: VscodeContributionBundle = {
        themes: [],
        languages: [],
        grammars: [],
        snippets: [],
        commands: [],
        configurationDefaults: {}
      }
      for (const extension of store.loadEnabled()) {
        collectInto(bundle, extension)
      }
      return bundle
    },

    installFromVsix: (archivePath) => announce(installVsixFile(archivePath, { store })),
    installFromDirectory: (directory) => announce(store.installFromDirectory(directory)),
    remove: (extensionId) => announce(store.remove(extensionId)),

    readGrammar(extensionId, scopeName) {
      const grammarPath = loadedGrammarPath(extensionId, scopeName)
      if (grammarPath === null) {
        return { ok: false, error: 'grammar is not installed or not enabled' }
      }
      const extensionRoot = store.directoryFor(extensionId)
      if (extensionRoot === null) {
        return { ok: false, error: 'extension is not installed' }
      }
      // Re-checked against the extension root even though the path came from
      // the loader: containment is asserted at every read, not just discovery.
      const relative = grammarPath.slice(extensionRoot.length + 1)
      return readContainedFile(extensionRoot, relative)
    },

    extensionsRoot: () => root
  }
}

function collectInto(bundle: VscodeContributionBundle, extension: LoadedVscodeExtension): void {
  const extensionId = extension.extensionId
  for (const theme of extension.themes) {
    bundle.themes.push({ ...theme, extensionId })
  }
  for (const language of extension.languages) {
    bundle.languages.push({
      extensionId,
      id: language.id,
      extensions: language.extensions,
      aliases: language.aliases,
      filenames: language.filenames,
      configuration: language.configuration
    })
  }
  for (const grammar of extension.grammars) {
    bundle.grammars.push({
      extensionId,
      scopeName: grammar.scopeName,
      languageId: grammar.languageId,
      embeddedLanguages: grammar.embeddedLanguages
    })
  }
  for (const entry of extension.snippets) {
    bundle.snippets.push({ extensionId, languageId: entry.languageId, snippets: entry.snippets })
  }
  for (const command of extension.commands) {
    bundle.commands.push({ extensionId, command: command.command, title: command.title })
  }
  // Earlier extensions win, matching the order `loadEnabled` returns.
  for (const [key, value] of Object.entries(extension.configurationDefaults)) {
    if (!(key in bundle.configurationDefaults)) {
      bundle.configurationDefaults[key] = value
    }
  }
}
