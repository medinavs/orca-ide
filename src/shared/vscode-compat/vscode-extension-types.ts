/**
 * VS Code extension shapes shared by main, preload and the renderer.
 *
 * In `shared` because the renderer and preload receive these over IPC and must
 * not import from `src/main`, which the web typecheck project excludes.
 */
import type { MonacoThemeData } from './vscode-theme-adapter'
import type { MonacoLanguageConfiguration } from './vscode-language-configuration'
import type { ParsedSnippet } from './vscode-snippets'

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

export type VscodeContributionBundle = {
  themes: {
    id: string
    label: string
    type: string
    extensionId: string
    data: MonacoThemeData
  }[]
  languages: {
    extensionId: string
    id: string
    extensions: string[]
    aliases: string[]
    filenames: string[]
    configuration?: MonacoLanguageConfiguration
  }[]
  grammars: {
    extensionId: string
    scopeName: string
    languageId?: string
    embeddedLanguages?: Record<string, string>
  }[]
  snippets: { extensionId: string; languageId: string; snippets: ParsedSnippet[] }[]
  commands: { extensionId: string; command: string; title: string }[]
  configurationDefaults: Record<string, unknown>
}
