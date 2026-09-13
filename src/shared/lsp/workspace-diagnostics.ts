/**
 * The wire shape every diagnostic reader subscribes to, plus the rollups the
 * explorer and the summary chip need.
 *
 * One published snapshot serves all four surfaces (markers, Problems panel,
 * explorer badges, summary), so none of them can disagree about what is wrong
 * with a file — the bug you get from letting each surface keep its own copy.
 */
import {
  addDiagnosticCounts,
  countDiagnostics,
  emptyDiagnosticCounts,
  severityOfCounts,
  worstSeverity,
  type DiagnosticCounts,
  type DiagnosticSeverityName
} from './diagnostic-severity'
import type { LspDiagnostic } from './lsp-protocol-types'

/** One diagnostic as published, tagged with the server that produced it. */
export type PublishedDiagnostic = LspDiagnostic & {
  /** Server id from the catalog (`gopls`), for clearing one server's entries. */
  serverId: string
}

export type FileDiagnostics = {
  /** Absolute path on the execution host. */
  path: string
  /** Workspace-relative, forward-slashed — the key the explorer addresses. */
  relativePath: string
  diagnostics: PublishedDiagnostic[]
}

export type WorkspaceDiagnosticsSnapshot = {
  rootPath: string
  /** Only files that currently have at least one diagnostic. */
  files: FileDiagnostics[]
}

export type DiagnosticEntryLocation = {
  path: string
  relativePath: string
  /** 1-based, as the Problems panel shows them and Monaco reveals them. */
  line: number
  column: number
}

/**
 * Normalizes a host path to the workspace-relative, forward-slashed form.
 *
 * `caseInsensitive` is a parameter rather than a `process.platform` read
 * because this module is imported by the renderer, which has no `process` —
 * and because the host whose paths these are may not be the host comparing
 * them. The caller that knows the execution host decides.
 */
export function toWorkspaceRelativePath(
  rootPath: string,
  absolutePath: string,
  options: { caseInsensitive?: boolean } = {}
): string {
  const normalizedRoot = rootPath.replace(/[\\/]+$/, '').replace(/\\/g, '/')
  const normalized = absolutePath.replace(/\\/g, '/')
  const rootPrefix = `${normalizedRoot}/`
  const fold = (value: string): string =>
    options.caseInsensitive === true ? value.toLowerCase() : value
  if (fold(normalized).startsWith(fold(rootPrefix))) {
    return normalized.slice(rootPrefix.length)
  }
  // Outside the workspace (a dependency source a server points at) keeps its
  // absolute form rather than being faked into the tree with `../..` noise.
  return normalized
}

export function fileDiagnosticCounts(file: FileDiagnostics): DiagnosticCounts {
  return countDiagnostics(file.diagnostics)
}

export function snapshotDiagnosticCounts(
  snapshot: WorkspaceDiagnosticsSnapshot
): DiagnosticCounts {
  const total = emptyDiagnosticCounts()
  for (const file of snapshot.files) {
    addDiagnosticCounts(total, fileDiagnosticCounts(file))
  }
  return total
}

export type DiagnosticTreeBadges = {
  /** Worst severity per workspace-relative file path. */
  files: Map<string, DiagnosticSeverityName>
  /**
   * Worst severity per ancestor directory, so a collapsed folder still shows
   * that something inside it is broken. Keys are relative, no trailing slash;
   * the workspace root is the empty string.
   */
  directories: Map<string, DiagnosticSeverityName>
}

/**
 * Worst-severity badges for the explorer, propagated to every ancestor.
 *
 * Propagation is the whole point: a user collapses `src/` and must still see
 * that something under it fails, otherwise the badge only helps when the tree
 * is already fully expanded — which is when they needed it least.
 */
export function buildDiagnosticTreeBadges(
  snapshot: WorkspaceDiagnosticsSnapshot
): DiagnosticTreeBadges {
  const files = new Map<string, DiagnosticSeverityName>()
  const directories = new Map<string, DiagnosticSeverityName>()
  for (const file of snapshot.files) {
    const severity = severityOfCounts(fileDiagnosticCounts(file))
    if (severity === null) {
      continue
    }
    files.set(file.relativePath, worstSeverity(files.get(file.relativePath) ?? null, severity)!)
    const segments = file.relativePath.split('/')
    // Every prefix of the path, plus '' for the root itself.
    let prefix = ''
    directories.set('', worstSeverity(directories.get('') ?? null, severity)!)
    for (const segment of segments.slice(0, -1)) {
      prefix = prefix === '' ? segment : `${prefix}/${segment}`
      directories.set(prefix, worstSeverity(directories.get(prefix) ?? null, severity)!)
    }
  }
  return { files, directories }
}

/** Problems-panel ordering: worst files first, then by path, then by position. */
export function sortFileDiagnostics(files: readonly FileDiagnostics[]): FileDiagnostics[] {
  const rank: Record<DiagnosticSeverityName, number> = {
    error: 0,
    warning: 1,
    information: 2,
    hint: 3
  }
  return [...files]
    .map((file) => ({
      ...file,
      diagnostics: [...file.diagnostics].sort(
        (left, right) =>
          left.range.start.line - right.range.start.line ||
          left.range.start.character - right.range.start.character
      )
    }))
    .sort((left, right) => {
      const leftWorst = severityOfCounts(fileDiagnosticCounts(left))
      const rightWorst = severityOfCounts(fileDiagnosticCounts(right))
      const leftRank = leftWorst === null ? 9 : rank[leftWorst]
      const rightRank = rightWorst === null ? 9 : rank[rightWorst]
      return leftRank - rightRank || left.relativePath.localeCompare(right.relativePath)
    })
}
