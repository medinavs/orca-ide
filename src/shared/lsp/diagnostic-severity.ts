/**
 * Severity vocabulary shared by every diagnostic reader — Monaco markers, the
 * Problems panel, the explorer badges and the summary chip.
 *
 * LSP numbers severities 1..4 and Monaco numbers them 8/4/2/1 in the opposite
 * direction, which is exactly the kind of mapping that gets inverted once and
 * then ships a warning icon on an error. It is written down once, here, and
 * every surface converts through it.
 */
import type { LspDiagnostic, LspDiagnosticSeverity } from './lsp-protocol-types'

export type DiagnosticSeverityName = 'error' | 'warning' | 'information' | 'hint'

export const DIAGNOSTIC_SEVERITY_NAMES: readonly DiagnosticSeverityName[] = [
  'error',
  'warning',
  'information',
  'hint'
]

const BY_LSP_CODE: Record<LspDiagnosticSeverity, DiagnosticSeverityName> = {
  1: 'error',
  2: 'warning',
  3: 'information',
  4: 'hint'
}

/**
 * A diagnostic with no severity is an error by LSP's own default — servers omit
 * it for their most serious findings, so defaulting to `hint` would hide them.
 */
export function severityName(severity: LspDiagnosticSeverity | undefined): DiagnosticSeverityName {
  return severity === undefined ? 'error' : (BY_LSP_CODE[severity] ?? 'error')
}

/** Rank for "worst severity wins" rollups; higher is worse. */
const SEVERITY_RANK: Record<DiagnosticSeverityName, number> = {
  error: 4,
  warning: 3,
  information: 2,
  hint: 1
}

export function worstSeverity(
  left: DiagnosticSeverityName | null,
  right: DiagnosticSeverityName | null
): DiagnosticSeverityName | null {
  if (left === null) {
    return right
  }
  if (right === null) {
    return left
  }
  return SEVERITY_RANK[left] >= SEVERITY_RANK[right] ? left : right
}

export type DiagnosticCounts = Record<DiagnosticSeverityName, number>

export function emptyDiagnosticCounts(): DiagnosticCounts {
  return { error: 0, warning: 0, information: 0, hint: 0 }
}

export function countDiagnostics(diagnostics: readonly LspDiagnostic[]): DiagnosticCounts {
  const counts = emptyDiagnosticCounts()
  for (const diagnostic of diagnostics) {
    counts[severityName(diagnostic.severity)] += 1
  }
  return counts
}

export function addDiagnosticCounts(
  into: DiagnosticCounts,
  from: DiagnosticCounts
): DiagnosticCounts {
  for (const name of DIAGNOSTIC_SEVERITY_NAMES) {
    into[name] += from[name]
  }
  return into
}

export function totalDiagnostics(counts: DiagnosticCounts): number {
  return DIAGNOSTIC_SEVERITY_NAMES.reduce((total, name) => total + counts[name], 0)
}

/** The worst severity present, or null when there are no diagnostics at all. */
export function severityOfCounts(counts: DiagnosticCounts): DiagnosticSeverityName | null {
  for (const name of DIAGNOSTIC_SEVERITY_NAMES) {
    if (counts[name] > 0) {
      return name
    }
  }
  return null
}
