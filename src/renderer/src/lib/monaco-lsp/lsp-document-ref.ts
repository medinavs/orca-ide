/**
 * Decides whether an editor tab is something a language server should see, and
 * builds its document ref.
 *
 * Most of this is exclusions, and each one is a file a server would either
 * reject or answer wrongly:
 *
 * - a diff or combined-diff tab holds two versions concatenated, so every
 *   diagnostic would land on the wrong line
 * - an untitled buffer has no path on the host's disk
 * - a check-run tab is fetched CI metadata, not a file
 * - a file outside the worktree, or on another SSH target, belongs to a
 *   different host than the workspace whose server would analyse it
 *
 * This is why diagnostics stay off Orca's existing diff surfaces, which
 * deliberately disable them (see `monaco-setup.ts`).
 */
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import type { LanguageDocumentRef } from '../../../../preload/api/language-server-api'

export type LspTabCandidate = {
  filePath: string
  worktreeId: string
  language: string
  isUntitled?: boolean
  diffSource?: unknown
  combinedAlternate?: unknown
  checkRunDetails?: unknown
  externalSshTargetId?: string
  markdownPreviewSourceFileId?: string
}

export type LspWorkspaceCandidate = {
  id: string
  /** Worktree root on its host. */
  path: string
  hostId?: ExecutionHostId
}

/** Languages with no server are skipped before any IPC is spent on them. */
export type LspDocumentRefResolution =
  | { ok: true; ref: LanguageDocumentRef }
  | { ok: false; reason: 'not-a-file' | 'no-workspace' | 'outside-workspace' }

function isInside(rootPath: string, filePath: string, caseInsensitive: boolean): boolean {
  const root = rootPath.replace(/[\\/]+$/, '').replace(/\\/g, '/')
  const file = filePath.replace(/\\/g, '/')
  const prefix = `${root}/`
  return caseInsensitive
    ? file.toLowerCase().startsWith(prefix.toLowerCase())
    : file.startsWith(prefix)
}

export function resolveLspDocumentRef(
  tab: LspTabCandidate,
  workspaces: readonly LspWorkspaceCandidate[],
  options: { caseInsensitivePaths?: boolean } = {}
): LspDocumentRefResolution {
  if (
    tab.isUntitled === true ||
    tab.diffSource !== undefined ||
    tab.combinedAlternate !== undefined ||
    tab.checkRunDetails !== undefined ||
    tab.markdownPreviewSourceFileId !== undefined ||
    tab.externalSshTargetId !== undefined ||
    tab.filePath === ''
  ) {
    return { ok: false, reason: 'not-a-file' }
  }
  const workspace = workspaces.find((candidate) => candidate.id === tab.worktreeId)
  if (!workspace) {
    return { ok: false, reason: 'no-workspace' }
  }
  if (!isInside(workspace.path, tab.filePath, options.caseInsensitivePaths === true)) {
    // A server rooted at this workspace cannot answer for a file outside it.
    return { ok: false, reason: 'outside-workspace' }
  }
  return {
    ok: true,
    ref: {
      executionHostId: workspace.hostId ?? LOCAL_EXECUTION_HOST_ID,
      rootPath: workspace.path,
      path: tab.filePath,
      languageId: tab.language
    }
  }
}
