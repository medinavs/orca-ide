import { describe, expect, it } from 'vitest'
import {
  addDiagnosticCounts,
  countDiagnostics,
  emptyDiagnosticCounts,
  severityName,
  severityOfCounts,
  totalDiagnostics,
  worstSeverity
} from './diagnostic-severity'
import type { LspDiagnostic } from './lsp-protocol-types'

function diagnostic(severity?: 1 | 2 | 3 | 4): LspDiagnostic {
  return {
    message: 'x',
    severity,
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
  }
}

describe('severityName', () => {
  it('names the four LSP severities', () => {
    expect(severityName(1)).toBe('error')
    expect(severityName(2)).toBe('warning')
    expect(severityName(3)).toBe('information')
    expect(severityName(4)).toBe('hint')
  })

  it('treats a missing severity as an error, per the LSP default', () => {
    // Servers omit severity for their most serious findings; defaulting to
    // `hint` would quietly hide real errors from every surface at once.
    expect(severityName(undefined)).toBe('error')
  })
})

describe('worstSeverity', () => {
  it('picks the worse of two', () => {
    expect(worstSeverity('warning', 'error')).toBe('error')
    expect(worstSeverity('error', 'warning')).toBe('error')
    expect(worstSeverity('hint', 'information')).toBe('information')
  })

  it('passes through a null side', () => {
    expect(worstSeverity(null, 'warning')).toBe('warning')
    expect(worstSeverity('warning', null)).toBe('warning')
    expect(worstSeverity(null, null)).toBeNull()
  })

  it('is stable for equal severities', () => {
    expect(worstSeverity('warning', 'warning')).toBe('warning')
  })
})

describe('countDiagnostics', () => {
  it('counts each severity', () => {
    expect(
      countDiagnostics([diagnostic(1), diagnostic(1), diagnostic(2), diagnostic(4)])
    ).toEqual({ error: 2, warning: 1, information: 0, hint: 1 })
  })

  it('returns zeros for an empty list', () => {
    expect(countDiagnostics([])).toEqual(emptyDiagnosticCounts())
  })
})

describe('count helpers', () => {
  it('adds one count set into another', () => {
    const into = { error: 1, warning: 0, information: 0, hint: 0 }
    addDiagnosticCounts(into, { error: 2, warning: 3, information: 0, hint: 0 })
    expect(into).toEqual({ error: 3, warning: 3, information: 0, hint: 0 })
  })

  it('totals every severity', () => {
    expect(totalDiagnostics({ error: 1, warning: 2, information: 3, hint: 4 })).toBe(10)
  })

  it('reports the worst severity present', () => {
    expect(severityOfCounts({ error: 0, warning: 1, information: 5, hint: 0 })).toBe('warning')
    expect(severityOfCounts({ error: 0, warning: 0, information: 0, hint: 2 })).toBe('hint')
  })

  it('reports null when nothing is wrong', () => {
    expect(severityOfCounts(emptyDiagnosticCounts())).toBeNull()
  })
})
