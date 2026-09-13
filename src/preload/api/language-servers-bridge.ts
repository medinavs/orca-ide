import { ipcRenderer } from 'electron'
import type { LanguageServerStatus } from '../../shared/lsp/language-server-status'
import type { WorkspaceDiagnosticsSnapshot } from '../../shared/lsp/workspace-diagnostics'
import type {
  LanguageDocumentRef,
  LanguageFeatureResult,
  LanguageServerOpenResult,
  LanguageServersApi
} from './language-server-api'
import type { PreloadApi } from '../api-types'

export const languageServersApi = {
  openDocument: (ref: LanguageDocumentRef, text: string): Promise<LanguageServerOpenResult> =>
    ipcRenderer.invoke('lsp:openDocument', { ref, text }),
  changeDocument: (ref: LanguageDocumentRef, text: string): Promise<void> =>
    ipcRenderer.invoke('lsp:changeDocument', { ref, text }),
  saveDocument: (ref: LanguageDocumentRef): Promise<void> =>
    ipcRenderer.invoke('lsp:saveDocument', ref),
  closeDocument: (ref: LanguageDocumentRef): Promise<void> =>
    ipcRenderer.invoke('lsp:closeDocument', ref),
  request: <T>(
    ref: LanguageDocumentRef,
    method: string,
    params?: unknown
  ): Promise<LanguageFeatureResult<T>> =>
    ipcRenderer.invoke('lsp:request', { ref, method, params }),
  diagnostics: (rootPath: string): Promise<WorkspaceDiagnosticsSnapshot> =>
    ipcRenderer.invoke('lsp:diagnostics', { rootPath }),
  statuses: (): Promise<LanguageServerStatus[]> => ipcRenderer.invoke('lsp:statuses'),
  restart: (args): Promise<void> => ipcRenderer.invoke('lsp:restart', args),
  stopWorkspace: (args): Promise<void> => ipcRenderer.invoke('lsp:stopWorkspace', args),
  onDiagnosticsChanged: (callback): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      snapshot: WorkspaceDiagnosticsSnapshot
    ): void => callback(snapshot)
    ipcRenderer.on('lsp:diagnosticsChanged', listener)
    return () => {
      ipcRenderer.removeListener('lsp:diagnosticsChanged', listener)
    }
  },
  onStatusChanged: (callback): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: LanguageServerStatus): void =>
      callback(status)
    ipcRenderer.on('lsp:statusChanged', listener)
    return () => {
      ipcRenderer.removeListener('lsp:statusChanged', listener)
    }
  }
} satisfies LanguageServersApi satisfies PreloadApi['languageServers']
