import { ipcRenderer } from 'electron'
import type {
  InstalledVscodeExtension,
  VscodeContributionBundle
} from '../../shared/vscode-compat/vscode-extension-types'
import type { PreloadApi } from '../api-types'

export type VscodeExtensionInstallOutcome =
  | { ok: true; extension: InstalledVscodeExtension }
  | { ok: false; error?: string; canceled?: boolean }

export type VscodeExtensionsApi = {
  list: () => Promise<InstalledVscodeExtension[]>
  /** Everything the renderer registers in Monaco for enabled extensions. */
  contributions: () => Promise<VscodeContributionBundle>
  /** Opens a native file picker in main; the renderer never supplies a path. */
  installFromVsix: () => Promise<VscodeExtensionInstallOutcome>
  installFromDirectory: () => Promise<VscodeExtensionInstallOutcome>
  remove: (args: { extensionId: string }) => Promise<{ removed: boolean }>
  /** Grammar JSON, fetched when a language is first opened. */
  readGrammar: (args: {
    extensionId: string
    scopeName: string
  }) => Promise<{ ok: true; contents: string } | { ok: false; error: string }>
  onChanged: (callback: () => void) => () => void
}

export const vscodeExtensionsApi = {
  list: () => ipcRenderer.invoke('vscodeExtensions:list'),
  contributions: () => ipcRenderer.invoke('vscodeExtensions:contributions'),
  installFromVsix: () => ipcRenderer.invoke('vscodeExtensions:installFromVsix'),
  installFromDirectory: () => ipcRenderer.invoke('vscodeExtensions:installFromDirectory'),
  remove: (args) => ipcRenderer.invoke('vscodeExtensions:remove', args),
  readGrammar: (args) => ipcRenderer.invoke('vscodeExtensions:readGrammar', args),
  onChanged: (callback): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('vscodeExtensions:changed', listener)
    return () => {
      ipcRenderer.removeListener('vscodeExtensions:changed', listener)
    }
  }
} satisfies VscodeExtensionsApi satisfies PreloadApi['vscodeExtensions']
