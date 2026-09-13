/**
 * LSP diagnostics → Monaco markers.
 *
 * Markers are Monaco's own diagnostic mechanism, so using them means the
 * squiggle, the hover message, the gutter glyph, the minimap tick and the
 * overview ruler all come for free and stay theme-driven. Nothing here paints.
 *
 * Two conversions are easy to get wrong and are therefore the whole content of
 * this module: LSP positions are 0-based where Monaco's are 1-based, and the
 * two severity scales run in opposite directions.
 */
import type { editor } from 'monaco-editor'
import {
  severityName,
  type DiagnosticSeverityName
} from '../../../../shared/lsp/diagnostic-severity'
import type { LspDiagnostic, LspRange } from '../../../../shared/lsp/lsp-protocol-types'
import type { PublishedDiagnostic } from '../../../../shared/lsp/workspace-diagnostics'

/**
 * `MarkerSeverity` values, inlined rather than imported: these modules take
 * only types from `monaco-editor` so they stay unit-testable in Node. The
 * mapping is pinned by a test.
 */
const MONACO_SEVERITY: Record<DiagnosticSeverityName, 1 | 2 | 4 | 8> = {
  error: 8,
  warning: 4,
  information: 2,
  hint: 1
}

export function toMonacoSeverity(diagnostic: Pick<LspDiagnostic, 'severity'>): 1 | 2 | 4 | 8 {
  return MONACO_SEVERITY[severityName(diagnostic.severity)]
}

export type MonacoRange = {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

/**
 * A zero-width range is widened by one column.
 *
 * Servers report a bare position for "something is missing here" (gopls does
 * it for a missing return), and Monaco renders a zero-width marker as nothing
 * at all — the diagnostic would exist in the Problems panel with no squiggle
 * to explain it.
 */
export function toMonacoRange(range: LspRange): MonacoRange {
  const startLineNumber = range.start.line + 1
  const startColumn = range.start.character + 1
  const endLineNumber = range.end.line + 1
  const endColumn = range.end.character + 1
  const empty = startLineNumber === endLineNumber && startColumn === endColumn
  return {
    startLineNumber,
    startColumn,
    endLineNumber,
    endColumn: empty ? endColumn + 1 : endColumn
  }
}

/** `gopls(UnusedVar)` — the source, with the server's code when it sent one. */
function markerSource(diagnostic: PublishedDiagnostic): string {
  // `source` is what the server calls itself ('gopls', 'typescript', 'eslint');
  // fall back to the Orca server id so a marker is never unattributed.
  return diagnostic.source ?? diagnostic.serverId
}

export function toMonacoMarker(diagnostic: PublishedDiagnostic): editor.IMarkerData {
  const range = toMonacoRange(diagnostic.range)
  return {
    ...range,
    severity: toMonacoSeverity(diagnostic),
    message: diagnostic.message,
    source: markerSource(diagnostic),
    code: diagnostic.code === undefined ? undefined : String(diagnostic.code),
    // Monaco renders these as navigable links inside the hover, which is how
    // "this is why" reaches the user without opening another panel.
    relatedInformation: diagnostic.relatedInformation?.map((related) => ({
      resource: related.location.uri as unknown as editor.IRelatedInformation['resource'],
      message: related.message,
      ...toMonacoRange(related.location.range)
    })),
    tags: diagnostic.tags as editor.IMarkerData['tags']
  }
}

export function toMonacoMarkers(
  diagnostics: readonly PublishedDiagnostic[]
): editor.IMarkerData[] {
  return diagnostics.map(toMonacoMarker)
}

/**
 * Marker owner for one language server.
 *
 * Monaco replaces all markers for an (model, owner) pair on every
 * `setModelMarkers`, so one owner per server is what makes a clean publication
 * from gopls clear only gopls's squiggles and leave eslint's alone — the same
 * invariant the main-process store keeps, enforced again at the editor.
 */
export function markerOwnerFor(serverId: string): string {
  return `orca.lsp.${serverId}`
}

export const LSP_MARKER_OWNER_PREFIX = 'orca.lsp.'

/** Groups a file's diagnostics by the owner each one must be written under. */
export function groupMarkersByOwner(
  diagnostics: readonly PublishedDiagnostic[]
): Map<string, editor.IMarkerData[]> {
  const byOwner = new Map<string, editor.IMarkerData[]>()
  for (const diagnostic of diagnostics) {
    const owner = markerOwnerFor(diagnostic.serverId)
    const existing = byOwner.get(owner)
    if (existing) {
      existing.push(toMonacoMarker(diagnostic))
      continue
    }
    byOwner.set(owner, [toMonacoMarker(diagnostic)])
  }
  return byOwner
}
