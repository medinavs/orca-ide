/**
 * Writes LSP diagnostics onto a Monaco model as markers.
 *
 * `setModelMarkers` replaces all markers for one (model, owner) pair, so the
 * non-obvious half of this is *clearing*: when a server stops reporting a
 * file, nothing arrives for that owner, and without an explicit empty write
 * its squiggles stay on screen forever. So each model remembers which owners
 * it last wrote, and owners that vanish are cleared rather than forgotten.
 *
 * Owner-scoped and not model-scoped: clearing every marker on the model would
 * also wipe markers Monaco's own built-in language services own (the JSON and
 * CSS workers still publish their own), and any other server's.
 */
import type { editor } from 'monaco-editor'
import type { PublishedDiagnostic } from '../../../../shared/lsp/workspace-diagnostics'
import { groupMarkersByOwner } from './lsp-marker-conversion'

/** The slice of Monaco this needs, so tests need no editor instance. */
export type MarkerWriter = {
  setModelMarkers(
    model: editor.ITextModel,
    owner: string,
    markers: editor.IMarkerData[]
  ): void
}

/** Owners last written per model, so disappearing ones can be cleared. */
export type ModelMarkerOwners = WeakMap<editor.ITextModel, Set<string>>

export function createModelMarkerOwners(): ModelMarkerOwners {
  return new WeakMap()
}

export function applyModelMarkers(
  writer: MarkerWriter,
  model: editor.ITextModel,
  diagnostics: readonly PublishedDiagnostic[],
  owners: ModelMarkerOwners
): void {
  if (model.isDisposed()) {
    return
  }
  const grouped = groupMarkersByOwner(diagnostics)
  const previous = owners.get(model) ?? new Set<string>()
  for (const [owner, markers] of grouped) {
    writer.setModelMarkers(model, owner, markers)
  }
  for (const owner of previous) {
    if (!grouped.has(owner)) {
      writer.setModelMarkers(model, owner, [])
    }
  }
  if (grouped.size === 0) {
    owners.delete(model)
    return
  }
  owners.set(model, new Set(grouped.keys()))
}

/** Clears every owner this module wrote for a model (document closing). */
export function clearModelMarkers(
  writer: MarkerWriter,
  model: editor.ITextModel,
  owners: ModelMarkerOwners
): void {
  const previous = owners.get(model)
  owners.delete(model)
  if (!previous || model.isDisposed()) {
    return
  }
  for (const owner of previous) {
    writer.setModelMarkers(model, owner, [])
  }
}
