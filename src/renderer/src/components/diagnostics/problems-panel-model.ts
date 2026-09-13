/**
 * The Problems panel's view model, separated from its rendering so the
 * grouping, ordering, filtering and collapse behaviour are testable without a
 * DOM.
 */
import {
  countDiagnostics,
  severityName,
  severityOfCounts,
  type DiagnosticCounts,
  type DiagnosticSeverityName
} from '../../../../shared/lsp/diagnostic-severity'
import {
  sortFileDiagnostics,
  type PublishedDiagnostic,
  type WorkspaceDiagnosticsSnapshot
} from '../../../../shared/lsp/workspace-diagnostics'
import { toDisplayPosition } from './diagnostic-severity-presentation'

export type ProblemsPanelRow = {
  key: string
  severity: DiagnosticSeverityName
  message: string
  /** `gopls`, `typescript`, `eslint` — what the server calls itself. */
  source: string
  code?: string
  line: number
  column: number
}

export type ProblemsPanelFileGroup = {
  path: string
  relativePath: string
  /** Basename, for the group header. */
  fileName: string
  /** Directory part, shown dimmed beside the name; empty at the root. */
  directory: string
  counts: DiagnosticCounts
  severity: DiagnosticSeverityName
  rows: ProblemsPanelRow[]
}

export type ProblemsPanelModel = {
  groups: ProblemsPanelFileGroup[]
  counts: DiagnosticCounts
  /** Total rows after filtering, for the empty state and the header. */
  total: number
}

function rowKey(diagnostic: PublishedDiagnostic, index: number): string {
  return [
    diagnostic.serverId,
    diagnostic.range.start.line,
    diagnostic.range.start.character,
    diagnostic.code ?? '',
    index
  ].join('|')
}

function splitPath(relativePath: string): { fileName: string; directory: string } {
  const separator = relativePath.lastIndexOf('/')
  return separator === -1
    ? { fileName: relativePath, directory: '' }
    : {
        fileName: relativePath.slice(separator + 1),
        directory: relativePath.slice(0, separator)
      }
}

export type ProblemsPanelFilter = {
  /** Case-insensitive substring over the message, source and path. */
  query?: string
  /** Severities to include; omit for all of them. */
  severities?: readonly DiagnosticSeverityName[]
}

function matchesQuery(
  query: string,
  relativePath: string,
  diagnostic: PublishedDiagnostic
): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') {
    return true
  }
  return (
    diagnostic.message.toLowerCase().includes(needle) ||
    relativePath.toLowerCase().includes(needle) ||
    (diagnostic.source ?? diagnostic.serverId).toLowerCase().includes(needle) ||
    String(diagnostic.code ?? '')
      .toLowerCase()
      .includes(needle)
  )
}

export function buildProblemsPanelModel(
  snapshot: WorkspaceDiagnosticsSnapshot,
  filter: ProblemsPanelFilter = {}
): ProblemsPanelModel {
  const allowed = filter.severities
  const groups: ProblemsPanelFileGroup[] = []
  const counts: DiagnosticCounts = { error: 0, warning: 0, information: 0, hint: 0 }
  let total = 0

  // Sorted first so files arrive worst-first and rows in document order; the
  // filter below preserves that order rather than re-deriving it.
  for (const file of sortFileDiagnostics(snapshot.files)) {
    const kept = file.diagnostics.filter(
      (diagnostic) =>
        (allowed === undefined || allowed.includes(severityName(diagnostic.severity))) &&
        matchesQuery(filter.query ?? '', file.relativePath, diagnostic)
    )
    if (kept.length === 0) {
      continue
    }
    const groupCounts = countDiagnostics(kept)
    for (const severity of ['error', 'warning', 'information', 'hint'] as const) {
      counts[severity] += groupCounts[severity]
    }
    total += kept.length
    groups.push({
      path: file.path,
      relativePath: file.relativePath,
      ...splitPath(file.relativePath),
      counts: groupCounts,
      severity: severityOfCounts(groupCounts) ?? 'hint',
      rows: kept.map((diagnostic, index) => {
        const position = toDisplayPosition(diagnostic.range.start)
        return {
          key: rowKey(diagnostic, index),
          severity: severityName(diagnostic.severity),
          message: diagnostic.message,
          source: diagnostic.source ?? diagnostic.serverId,
          code: diagnostic.code === undefined ? undefined : String(diagnostic.code),
          line: position.line,
          column: position.column
        }
      })
    })
  }

  return { groups, counts, total }
}
