/**
 * Which Monaco model corresponds to which language-server document.
 *
 * Monaco's providers are registered per *language*, not per editor, and are
 * handed a model and a position — with no way back to the React tree that
 * opened it. This registry is that way back: the editor binding records a
 * model's document ref when it opens, and providers look it up.
 *
 * Keyed by the model's URI string rather than by the model object because a
 * provider can be called with a model Monaco recreated for the same path.
 */
import type { editor } from 'monaco-editor'
import type { LanguageDocumentRef } from '../../../../preload/api/language-server-api'

const byModelUri = new Map<string, LanguageDocumentRef>()

export function registerLspDocument(model: editor.ITextModel, ref: LanguageDocumentRef): void {
  byModelUri.set(model.uri.toString(), ref)
}

export function unregisterLspDocument(model: editor.ITextModel): void {
  byModelUri.delete(model.uri.toString())
}

/** Null when this model is not bound to a server — a diff sub-editor, say. */
export function lspDocumentForModel(model: editor.ITextModel): LanguageDocumentRef | null {
  return byModelUri.get(model.uri.toString()) ?? null
}

/** Test seam. */
export function clearLspDocumentRegistry(): void {
  byModelUri.clear()
}

export function lspDocumentRegistrySize(): number {
  return byModelUri.size
}
