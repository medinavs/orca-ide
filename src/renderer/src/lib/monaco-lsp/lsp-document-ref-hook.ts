/**
 * Resolves an editor tab into an LSP document ref, for callers that already
 * know the workspace list.
 *
 * Split from `use-lsp-document.ts` so the editor component itself needs no
 * workspace state: only the surface that renders a real file tab resolves one.
 */
import { useMemo } from 'react'
import type { LanguageDocumentRef } from '../../../../preload/api/language-server-api'
import {
  resolveLspDocumentRef,
  type LspTabCandidate,
  type LspWorkspaceCandidate
} from './lsp-document-ref'

export function useLspDocumentRef(
  tab: LspTabCandidate | null,
  workspaces: readonly LspWorkspaceCandidate[]
): LanguageDocumentRef | null {
  const caseInsensitive = useMemo(() => /Windows|Mac/i.test(navigator.userAgent), [])
  // Depended on field by field rather than on `tab`: callers rebuild that
  // object every render, so depending on its identity would re-resolve — and
  // therefore reopen the document on the server — on every keystroke.
  const filePath = tab?.filePath ?? ''
  const worktreeId = tab?.worktreeId ?? ''
  const language = tab?.language ?? ''
  const isUntitled = tab?.isUntitled === true
  const isDiff = tab?.diffSource !== undefined || tab?.combinedAlternate !== undefined
  const isCheckRun = tab?.checkRunDetails !== undefined
  const externalSshTargetId = tab?.externalSshTargetId
  const previewSourceId = tab?.markdownPreviewSourceFileId

  return useMemo(() => {
    if (filePath === '') {
      return null
    }
    const resolved = resolveLspDocumentRef(
      {
        filePath,
        worktreeId,
        language,
        isUntitled,
        // Collapsed to booleans above; the resolver only tests for presence.
        diffSource: isDiff ? true : undefined,
        checkRunDetails: isCheckRun ? true : undefined,
        externalSshTargetId,
        markdownPreviewSourceFileId: previewSourceId
      },
      workspaces,
      { caseInsensitivePaths: caseInsensitive }
    )
    return resolved.ok ? resolved.ref : null
  }, [
    caseInsensitive,
    workspaces,
    filePath,
    worktreeId,
    language,
    isUntitled,
    isDiff,
    isCheckRun,
    externalSshTargetId,
    previewSourceId
  ])
}
