/**
 * Renderer-facing contract for LSP. Paths only — the renderer never handles
 * `file://` URIs, which main builds and resolves for it (see
 * `src/main/lsp/lsp-uri-normalization.ts`).
 */
import type { ExecutionHostId } from '../../shared/execution-host'
import type { LanguageServerStatus } from '../../shared/lsp/language-server-status'
import type { LanguageServerUnavailable } from '../../shared/lsp/language-server-status'
import type { WorkspaceDiagnosticsSnapshot } from '../../shared/lsp/workspace-diagnostics'

export type LanguageDocumentRef = {
  executionHostId: ExecutionHostId
  /** Absolute workspace root on that host. */
  rootPath: string
  /** Absolute file path on that host. */
  path: string
  /** Monaco language id, as `language-detect.ts` resolves it. */
  languageId: string
}

export type LanguageServerOpenResult =
  | { ok: true; serverId: string; label: string }
  | { ok: false; unavailable: LanguageServerUnavailable }

export type LanguageFeatureResult<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; reason: 'unavailable' | 'unsupported'; message: string }

export type LanguageServersApi = {
  /** Starts the server for this language if needed, then opens the document. */
  openDocument: (ref: LanguageDocumentRef, text: string) => Promise<LanguageServerOpenResult>
  changeDocument: (ref: LanguageDocumentRef, text: string) => Promise<void>
  saveDocument: (ref: LanguageDocumentRef) => Promise<void>
  closeDocument: (ref: LanguageDocumentRef) => Promise<void>
  /**
   * A capability-gated language-feature request. Resolves with
   * `{ ok: false, reason: 'unsupported' }` rather than rejecting when the
   * server does not provide the feature, so callers render nothing instead of
   * surfacing an error.
   */
  request: <T = unknown>(
    ref: LanguageDocumentRef,
    method: string,
    params?: unknown
  ) => Promise<LanguageFeatureResult<T>>
  diagnostics: (rootPath: string) => Promise<WorkspaceDiagnosticsSnapshot>
  statuses: () => Promise<LanguageServerStatus[]>
  stopWorkspace: (args: { executionHostId: ExecutionHostId; rootPath: string }) => Promise<void>
  /** Fires whenever any file's diagnostics change in a workspace. */
  onDiagnosticsChanged: (callback: (snapshot: WorkspaceDiagnosticsSnapshot) => void) => () => void
  onStatusChanged: (callback: (status: LanguageServerStatus) => void) => () => void
}
