import { describe, expect, it } from 'vitest'
import type {
  PublishedDiagnostic,
  WorkspaceDiagnosticsSnapshot
} from '../../../../shared/lsp/workspace-diagnostics'
import { buildProblemsPanelModel } from './problems-panel-model'

function diagnostic(overrides: Partial<PublishedDiagnostic> = {}): PublishedDiagnostic {
  return {
    serverId: 'gopls',
    message: 'undefined: foo.Bar',
    severity: 1,
    range: { start: { line: 11, character: 4 }, end: { line: 11, character: 11 } },
    ...overrides
  }
}

function snapshot(
  files: { relativePath: string; diagnostics: PublishedDiagnostic[] }[]
): WorkspaceDiagnosticsSnapshot {
  return {
    rootPath: '/repo',
    files: files.map((file) => ({
      path: `/repo/${file.relativePath}`,
      relativePath: file.relativePath,
      diagnostics: file.diagnostics
    }))
  }
}

describe('buildProblemsPanelModel', () => {
  it('groups diagnostics by file', () => {
    const model = buildProblemsPanelModel(
      snapshot([
        { relativePath: 'main.go', diagnostics: [diagnostic()] },
        { relativePath: 'service.go', diagnostics: [diagnostic({ message: 'cannot use X as Y' })] }
      ])
    )
    expect(model.groups.map((group) => group.relativePath)).toEqual(['main.go', 'service.go'])
    expect(model.total).toBe(2)
  })

  it('converts LSP positions to the 1-based line and column the panel shows', () => {
    const model = buildProblemsPanelModel(
      snapshot([{ relativePath: 'main.go', diagnostics: [diagnostic()] }])
    )
    expect(model.groups[0]!.rows[0]).toMatchObject({ line: 12, column: 5 })
  })

  it('splits the header into file name and directory', () => {
    const model = buildProblemsPanelModel(
      snapshot([{ relativePath: 'src/service/auction.go', diagnostics: [diagnostic()] }])
    )
    expect(model.groups[0]).toMatchObject({
      fileName: 'auction.go',
      directory: 'src/service'
    })
  })

  it('leaves the directory empty for a root file', () => {
    const model = buildProblemsPanelModel(
      snapshot([{ relativePath: 'main.go', diagnostics: [diagnostic()] }])
    )
    expect(model.groups[0]!.directory).toBe('')
  })

  it('shows the server reported source, falling back to the server id', () => {
    const model = buildProblemsPanelModel(
      snapshot([
        {
          relativePath: 'main.go',
          diagnostics: [
            diagnostic({ source: 'gopls' }),
            diagnostic({ source: undefined, serverId: 'pyright', range: {
              start: { line: 1, character: 0 },
              end: { line: 1, character: 2 }
            } })
          ]
        }
      ])
    )
    expect(model.groups[0]!.rows.map((row) => row.source)).toEqual(['pyright', 'gopls'])
  })

  it('orders files worst-severity first', () => {
    const model = buildProblemsPanelModel(
      snapshot([
        { relativePath: 'a-warning.go', diagnostics: [diagnostic({ severity: 2 })] },
        { relativePath: 'z-error.go', diagnostics: [diagnostic({ severity: 1 })] }
      ])
    )
    expect(model.groups.map((group) => group.relativePath)).toEqual([
      'z-error.go',
      'a-warning.go'
    ])
  })

  it('orders rows within a file by position', () => {
    const model = buildProblemsPanelModel(
      snapshot([
        {
          relativePath: 'main.go',
          diagnostics: [
            diagnostic({
              message: 'later',
              range: { start: { line: 30, character: 0 }, end: { line: 30, character: 1 } }
            }),
            diagnostic({
              message: 'earlier',
              range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } }
            })
          ]
        }
      ])
    )
    expect(model.groups[0]!.rows.map((row) => row.message)).toEqual(['earlier', 'later'])
  })

  it('counts by severity across the workspace and per file', () => {
    const model = buildProblemsPanelModel(
      snapshot([
        {
          relativePath: 'main.go',
          diagnostics: [diagnostic({ severity: 1 }), diagnostic({ severity: 2 })]
        },
        { relativePath: 'b.go', diagnostics: [diagnostic({ severity: 2 })] }
      ])
    )
    expect(model.counts).toEqual({ error: 1, warning: 2, information: 0, hint: 0 })
    expect(model.groups[0]!.counts).toMatchObject({ error: 1, warning: 1 })
    expect(model.groups[0]!.severity).toBe('error')
  })

  it('gives each row a key stable enough for React but unique per diagnostic', () => {
    const model = buildProblemsPanelModel(
      snapshot([
        {
          relativePath: 'main.go',
          diagnostics: [diagnostic({ message: 'one' }), diagnostic({ message: 'two' })]
        }
      ])
    )
    const keys = model.groups[0]!.rows.map((row) => row.key)
    // Same position and server on both, so the index is what separates them.
    expect(new Set(keys).size).toBe(2)
  })

  it('stringifies a numeric code', () => {
    const model = buildProblemsPanelModel(
      snapshot([{ relativePath: 'a.ts', diagnostics: [diagnostic({ code: 2304 })] }])
    )
    expect(model.groups[0]!.rows[0]!.code).toBe('2304')
  })

  it('is empty for a clean workspace', () => {
    expect(buildProblemsPanelModel({ rootPath: '/repo', files: [] })).toEqual({
      groups: [],
      counts: { error: 0, warning: 0, information: 0, hint: 0 },
      total: 0
    })
  })
})

describe('buildProblemsPanelModel filtering', () => {
  const SNAPSHOT = snapshot([
    {
      relativePath: 'src/main.go',
      diagnostics: [
        diagnostic({ message: 'undefined: foo.Bar', severity: 1, source: 'gopls' }),
        diagnostic({
          message: 'unused variable: result',
          severity: 2,
          source: 'gopls',
          range: { start: { line: 17, character: 1 }, end: { line: 17, character: 7 } }
        })
      ]
    },
    {
      relativePath: 'web/app.ts',
      diagnostics: [diagnostic({ message: 'cannot find name', severity: 1, source: 'typescript' })]
    }
  ])

  it('filters by severity', () => {
    const model = buildProblemsPanelModel(SNAPSHOT, { severities: ['warning'] })
    expect(model.total).toBe(1)
    expect(model.groups[0]!.rows[0]!.message).toBe('unused variable: result')
  })

  it('drops a file whose diagnostics are all filtered out', () => {
    const model = buildProblemsPanelModel(SNAPSHOT, { severities: ['warning'] })
    expect(model.groups.map((group) => group.relativePath)).toEqual(['src/main.go'])
  })

  it('matches the query against the message', () => {
    expect(buildProblemsPanelModel(SNAPSHOT, { query: 'unused' }).total).toBe(1)
  })

  it('matches the query against the path', () => {
    const model = buildProblemsPanelModel(SNAPSHOT, { query: 'web/' })
    expect(model.groups.map((group) => group.relativePath)).toEqual(['web/app.ts'])
  })

  it('matches the query against the source', () => {
    const model = buildProblemsPanelModel(SNAPSHOT, { query: 'typescript' })
    expect(model.total).toBe(1)
  })

  it('is case-insensitive and ignores surrounding whitespace', () => {
    expect(buildProblemsPanelModel(SNAPSHOT, { query: '  UNDEFINED ' }).total).toBe(1)
  })

  it('treats an empty query as no filter', () => {
    expect(buildProblemsPanelModel(SNAPSHOT, { query: '   ' }).total).toBe(3)
  })

  it('recounts after filtering rather than reporting the unfiltered totals', () => {
    const model = buildProblemsPanelModel(SNAPSHOT, { severities: ['error'] })
    expect(model.counts).toEqual({ error: 2, warning: 0, information: 0, hint: 0 })
  })
})
