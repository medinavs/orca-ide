/**
 * The main-process facade the editor talks to: one manager, one diagnostics
 * store, and the capability gate in front of language-feature requests.
 *
 * Mirrors `PluginService` in shape — a single owned service, created at
 * startup, with subscription seams the IPC layer binds to. Nothing here is
 * Electron-aware, so the headless runtime can host it too.
 */
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import type { LanguageServerOverrides } from '../../shared/lsp/language-server-catalog'
import type { WorkspaceDiagnosticsSnapshot } from '../../shared/lsp/workspace-diagnostics'
import { createDiagnosticsStore, type DiagnosticsStore } from './diagnostics-store'
import {
  isLanguageFeatureMethod,
  serverSupportsFeature,
  type LanguageFeatureMethod
} from './language-feature-methods'
import {
  createLanguageServerManager,
  type LanguageServerManager,
  type LanguageServerUnavailable
} from './language-server-manager'
import type { LanguageServerStatus } from './language-server-session'
import { annotateUriPaths, withDocumentUri } from './lsp-uri-normalization'

export type LanguageDocumentRef = {
  executionHostId: ExecutionHostId
  rootPath: string
  path: string
  languageId: string
}

export type LanguageServerOpenResult =
  | { ok: true; serverId: string; label: string }
  | { ok: false; unavailable: LanguageServerUnavailable }

export type LanguageFeatureResult<T = unknown> =
  | { ok: true; result: T }
  /** The server is absent, still starting, or never advertised the feature. */
  | { ok: false; reason: 'unavailable' | 'unsupported'; message: string }

export type LanguageServerServiceOptions = {
  /** Read on every server start so a settings edit needs no app restart. */
  overrides?: () => LanguageServerOverrides
  env?: NodeJS.ProcessEnv
  /** True when the local filesystem is case-insensitive (Windows, macOS). */
  caseInsensitivePaths?: boolean
  onLog?: (line: string) => void
}

export type LanguageServerService = {
  readonly diagnostics: DiagnosticsStore
  openDocument(ref: LanguageDocumentRef, text: string): LanguageServerOpenResult
  changeDocument(ref: LanguageDocumentRef, text: string): void
  saveDocument(ref: LanguageDocumentRef): void
  closeDocument(ref: LanguageDocumentRef): void
  /** Capability-gated request; never rejects for an unsupported feature. */
  requestFeature<T = unknown>(
    ref: LanguageDocumentRef,
    method: string,
    params?: unknown,
    signal?: AbortSignal
  ): Promise<LanguageFeatureResult<T>>
  diagnosticsSnapshot(rootPath: string): WorkspaceDiagnosticsSnapshot
  statuses(): LanguageServerStatus[]
  restart(ref: {
    executionHostId: ExecutionHostId
    rootPath: string
    serverId: string
  }): Promise<void>
  onStatusChanged(listener: (status: LanguageServerStatus) => void): () => void
  stopWorkspace(ref: { executionHostId: ExecutionHostId; rootPath: string }): Promise<void>
  dispose(reason: string): Promise<void>
}

export function createLanguageServerService(
  options: LanguageServerServiceOptions = {}
): LanguageServerService {
  const diagnostics = createDiagnosticsStore({
    caseInsensitivePaths: options.caseInsensitivePaths
  })
  const statusListeners = new Set<(status: LanguageServerStatus) => void>()
  const manager: LanguageServerManager = createLanguageServerManager({
    overrides: options.overrides,
    env: options.env,
    diagnostics,
    onLog: options.onLog,
    onStatus: (status) => {
      for (const listener of statusListeners) {
        listener(status)
      }
    }
  })

  return {
    diagnostics,

    openDocument(ref, text) {
      const result = manager.openDocument(ref, text)
      return result.ok
        ? { ok: true, serverId: result.spec.id, label: result.spec.label }
        : { ok: false, unavailable: result.unavailable }
    },

    changeDocument: (ref, text) => manager.changeDocument(ref, text),
    saveDocument: (ref) => manager.saveDocument(ref),
    closeDocument: (ref) => manager.closeDocument(ref),

    async requestFeature<T>(ref, method, params, signal) {
      if (!isLanguageFeatureMethod(method)) {
        return {
          ok: false,
          reason: 'unsupported',
          message: `${method} is not a language-feature request Orca forwards.`
        }
      }
      const found = manager.sessionFor(ref)
      if (!found.ok) {
        return { ok: false, reason: 'unavailable', message: found.unavailable.message }
      }
      const status = found.session.status()
      if (!serverSupportsFeature(status.capabilities, method as LanguageFeatureMethod)) {
        return {
          ok: false,
          reason: 'unsupported',
          message: `${found.spec.label} does not provide ${method}.`
        }
      }
      try {
        const raw = await found.session.request<T>(
          method,
          withDocumentUri(method, params, ref.path),
          signal
        )
        return { ok: true, result: annotateUriPaths(raw) }
      } catch (error) {
        // A failed request is not an editor error: a server that is reindexing
        // answers `ContentModified`, and Monaco should show nothing, not a toast.
        return { ok: false, reason: 'unavailable', message: String(error) }
      }
    },

    diagnosticsSnapshot: (rootPath) => diagnostics.snapshot(rootPath),
    statuses: () => manager.statuses(),
    restart: (ref) => manager.restart(ref),

    onStatusChanged(listener) {
      statusListeners.add(listener)
      return () => statusListeners.delete(listener)
    },

    async stopWorkspace(ref) {
      await manager.stopWorkspace(ref, 'workspace closed')
      diagnostics.clearWorkspace(ref.rootPath)
    },

    async dispose(reason) {
      await manager.stopAll(reason)
      statusListeners.clear()
    }
  }
}

/** Convenience for callers that only ever address the local host. */
export function localDocumentRef(
  rootPath: string,
  path: string,
  languageId: string
): LanguageDocumentRef {
  return { executionHostId: LOCAL_EXECUTION_HOST_ID, rootPath, path, languageId }
}
