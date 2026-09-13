/**
 * Binds one editor surface to its language server: opens the document, streams
 * edits, and keeps Monaco's markers in step with the published diagnostics.
 *
 * The edit stream is read from the model's own change events rather than from
 * a React prop. Orca owns post-mount content sync (see `MonacoEditor.tsx`), so
 * the prop is not updated on every keystroke — a server fed from it would
 * analyse text the user stopped looking at several edits ago.
 */
import { useEffect, useRef } from 'react'
import type { editor } from 'monaco-editor'
import {
  selectFileDiagnostics,
  startLspDiagnosticsSubscription,
  useLspDiagnosticsStore
} from '@/store/lsp-diagnostics'
import type { LanguageDocumentRef } from '../../../../preload/api/language-server-api'
import { monaco } from '@/lib/monaco-setup'
import {
  applyModelMarkers,
  clearModelMarkers,
  createModelMarkerOwners,
  type MarkerWriter
} from './apply-model-markers'
import { registerLspDocument, unregisterLspDocument } from './lsp-document-registry'
import { registerLspProvidersForLanguage } from './register-lsp-providers'

/** Long enough to coalesce a burst of typing, short enough to feel live. */
const EDIT_DEBOUNCE_MS = 250

const markerOwners = createModelMarkerOwners()

export type UseLspDocumentArgs = {
  /** Null until the editor mounts. */
  editorInstance: editor.IStandaloneCodeEditor | null
  /** Monaco's marker API; injected so tests need no editor. */
  markerWriter: MarkerWriter
  /**
   * The resolved document, or null when this surface has no language server.
   *
   * Passed in rather than derived here: resolving it needs the workspace list,
   * and making the editor component depend on that store slice couples every
   * Monaco surface — diff sub-editors, excerpts, notebook cells — to state
   * none of them use. `useLspDocumentRef` does the resolving for callers that
   * legitimately know about workspaces.
   */
  ref: LanguageDocumentRef | null
}

export function useLspDocument({
  editorInstance,
  markerWriter,
  ref
}: UseLspDocumentArgs): LanguageDocumentRef | null {
  // Keyed so the effects below re-run only on a genuinely different document.
  const refKey =
    ref === null ? null : `${ref.executionHostId}|${ref.rootPath}|${ref.path}|${ref.languageId}`
  const refRef = useRef(ref)
  refRef.current = ref

  // Open on arrival, close on departure. The model is read at open time so a
  // document opened mid-edit reaches the server as what is on screen.
  useEffect(() => {
    const api = window.api?.languageServers
    const model = editorInstance?.getModel() ?? null
    const current = refRef.current
    if (!api || !current || !model) {
      return
    }
    startLspDiagnosticsSubscription()
    void useLspDiagnosticsStore.getState().loadWorkspace(current.rootPath)
    // The registry is what lets Monaco's per-language providers — which only
    // ever see a model and a position — find this document again.
    registerLspDocument(model, current)
    registerLspProvidersForLanguage(monaco, current.languageId)
    void api.openDocument(current, model.getValue())
    return () => {
      void api.closeDocument(current)
      unregisterLspDocument(model)
      clearModelMarkers(markerWriter, model, markerOwners)
    }
  }, [editorInstance, markerWriter, refKey])

  // Stream edits from the model, debounced.
  useEffect(() => {
    const api = window.api?.languageServers
    const model = editorInstance?.getModel() ?? null
    const current = refRef.current
    if (!api || !current || !model) {
      return
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    const subscription = model.onDidChangeContent(() => {
      if (timer !== null) {
        clearTimeout(timer)
      }
      timer = setTimeout(() => {
        timer = null
        if (!model.isDisposed()) {
          void api.changeDocument(current, model.getValue())
        }
      }, EDIT_DEBOUNCE_MS)
    })
    return () => {
      if (timer !== null) {
        clearTimeout(timer)
      }
      subscription.dispose()
    }
  }, [editorInstance, refKey])

  // Apply markers whenever this file's diagnostics change.
  const fileDiagnostics = useLspDiagnosticsStore((state) =>
    ref === null ? null : selectFileDiagnostics(state, ref.rootPath, ref.path)
  )
  useEffect(() => {
    const model = editorInstance?.getModel() ?? null
    if (!model || refRef.current === null) {
      return
    }
    applyModelMarkers(markerWriter, model, fileDiagnostics?.diagnostics ?? [], markerOwners)
  }, [editorInstance, markerWriter, fileDiagnostics, refKey])

  return ref
}

/** Notifies the server that the buffer was written to disk. */
export function notifyLspDocumentSaved(ref: LanguageDocumentRef | null): void {
  if (ref === null) {
    return
  }
  void window.api?.languageServers?.saveDocument(ref)
}
