import { describe, expect, it } from 'vitest'
import type { PublishedDiagnostic } from '../../../../shared/lsp/workspace-diagnostics'
import {
  groupMarkersByOwner,
  markerOwnerFor,
  toMonacoMarker,
  toMonacoMarkers,
  toMonacoRange,
  toMonacoSeverity
} from './lsp-marker-conversion'

function published(overrides: Partial<PublishedDiagnostic> = {}): PublishedDiagnostic {
  return {
    serverId: 'gopls',
    message: 'undefined: foo.Bar',
    severity: 1,
    range: { start: { line: 11, character: 4 }, end: { line: 11, character: 11 } },
    ...overrides
  }
}

describe('toMonacoSeverity', () => {
  it('maps the four LSP severities onto MarkerSeverity', () => {
    // Monaco: Hint 1, Info 2, Warning 4, Error 8 — the opposite direction to
    // LSP's 1..4, which is why this mapping is pinned by a test.
    expect(toMonacoSeverity({ severity: 1 })).toBe(8)
    expect(toMonacoSeverity({ severity: 2 })).toBe(4)
    expect(toMonacoSeverity({ severity: 3 })).toBe(2)
    expect(toMonacoSeverity({ severity: 4 })).toBe(1)
  })

  it('treats a missing severity as an error, per the LSP default', () => {
    expect(toMonacoSeverity({ severity: undefined })).toBe(8)
  })
})

describe('toMonacoRange', () => {
  it('converts 0-based LSP positions to 1-based Monaco ones', () => {
    expect(
      toMonacoRange({ start: { line: 11, character: 4 }, end: { line: 11, character: 11 } })
    ).toEqual({ startLineNumber: 12, startColumn: 5, endLineNumber: 12, endColumn: 12 })
  })

  it('handles a multi-line range', () => {
    expect(
      toMonacoRange({ start: { line: 0, character: 0 }, end: { line: 3, character: 2 } })
    ).toEqual({ startLineNumber: 1, startColumn: 1, endLineNumber: 4, endColumn: 3 })
  })

  it('widens a zero-width range so the squiggle is visible', () => {
    // Monaco draws nothing for an empty range, so a "missing return here"
    // diagnostic would appear in the panel with no marker in the editor.
    expect(
      toMonacoRange({ start: { line: 4, character: 8 }, end: { line: 4, character: 8 } })
    ).toEqual({ startLineNumber: 5, startColumn: 9, endLineNumber: 5, endColumn: 10 })
  })

  it('does not widen a one-character range', () => {
    expect(
      toMonacoRange({ start: { line: 0, character: 0 }, end: { line: 0, character: 1 } })
    ).toMatchObject({ endColumn: 2 })
  })
})

describe('toMonacoMarker', () => {
  it('carries the message, range and severity', () => {
    expect(toMonacoMarker(published())).toMatchObject({
      message: 'undefined: foo.Bar',
      severity: 8,
      startLineNumber: 12,
      startColumn: 5,
      endColumn: 12
    })
  })

  it('prefers the server reported source', () => {
    expect(toMonacoMarker(published({ source: 'gopls' })).source).toBe('gopls')
    expect(toMonacoMarker(published({ source: 'eslint', serverId: 'typescript' })).source).toBe(
      'eslint'
    )
  })

  it('falls back to the server id so a marker is never unattributed', () => {
    expect(toMonacoMarker(published({ source: undefined, serverId: 'pyright' })).source).toBe(
      'pyright'
    )
  })

  it('stringifies a numeric diagnostic code', () => {
    expect(toMonacoMarker(published({ code: 2304 })).code).toBe('2304')
    expect(toMonacoMarker(published({ code: 'UnusedVar' })).code).toBe('UnusedVar')
    expect(toMonacoMarker(published({ code: undefined })).code).toBeUndefined()
  })

  it('converts related information ranges too', () => {
    const marker = toMonacoMarker(
      published({
        relatedInformation: [
          {
            message: 'first declared here',
            location: {
              uri: 'file:///repo/other.go',
              range: { start: { line: 2, character: 0 }, end: { line: 2, character: 6 } }
            }
          }
        ]
      })
    )
    expect(marker.relatedInformation).toEqual([
      expect.objectContaining({
        message: 'first declared here',
        startLineNumber: 3,
        startColumn: 1,
        endColumn: 7
      })
    ])
  })

  it('converts a list', () => {
    expect(toMonacoMarkers([published(), published({ severity: 2 })])).toHaveLength(2)
  })
})

describe('marker ownership', () => {
  it('namespaces the owner per server', () => {
    expect(markerOwnerFor('gopls')).toBe('orca.lsp.gopls')
    expect(markerOwnerFor('eslint')).not.toBe(markerOwnerFor('gopls'))
  })

  it('groups one file diagnostics by owner so a clean publish clears only one server', () => {
    const grouped = groupMarkersByOwner([
      published({ serverId: 'typescript', message: 'type error' }),
      published({ serverId: 'eslint', message: 'lint warning', severity: 2 }),
      published({ serverId: 'eslint', message: 'another lint', severity: 2 })
    ])
    expect([...grouped.keys()].sort()).toEqual(['orca.lsp.eslint', 'orca.lsp.typescript'])
    expect(grouped.get('orca.lsp.eslint')).toHaveLength(2)
    expect(grouped.get('orca.lsp.typescript')).toHaveLength(1)
  })

  it('returns an empty map for no diagnostics', () => {
    expect(groupMarkersByOwner([]).size).toBe(0)
  })
})
