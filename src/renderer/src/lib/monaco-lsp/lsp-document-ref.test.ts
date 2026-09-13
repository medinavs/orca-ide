import { describe, expect, it } from 'vitest'
import { resolveLspDocumentRef, type LspTabCandidate } from './lsp-document-ref'

const WORKSPACES = [
  { id: 'repo::/repo', path: '/repo' },
  { id: 'repo::/remote', path: '/remote', hostId: 'ssh:box' as const }
]

function tab(overrides: Partial<LspTabCandidate> = {}): LspTabCandidate {
  return {
    filePath: '/repo/src/main.go',
    worktreeId: 'repo::/repo',
    language: 'go',
    ...overrides
  }
}

describe('resolveLspDocumentRef', () => {
  it('builds a ref for an ordinary file in a workspace', () => {
    const result = resolveLspDocumentRef(tab(), WORKSPACES)
    expect(result).toEqual({
      ok: true,
      ref: {
        executionHostId: 'local',
        rootPath: '/repo',
        path: '/repo/src/main.go',
        languageId: 'go'
      }
    })
  })

  it('carries the workspace execution host so the manager can refuse it', () => {
    const result = resolveLspDocumentRef(
      tab({ worktreeId: 'repo::/remote', filePath: '/remote/main.go' }),
      WORKSPACES
    )
    expect(result.ok && result.ref.executionHostId).toBe('ssh:box')
  })

  it('defaults a workspace with no host to local', () => {
    const result = resolveLspDocumentRef(tab(), [{ id: 'repo::/repo', path: '/repo' }])
    expect(result.ok && result.ref.executionHostId).toBe('local')
  })
})

describe('resolveLspDocumentRef exclusions', () => {
  it('skips a diff tab, whose buffer is two versions at once', () => {
    // Diagnostics on concatenated original+modified text land on wrong lines.
    expect(resolveLspDocumentRef(tab({ diffSource: { kind: 'git' } }), WORKSPACES)).toEqual({
      ok: false,
      reason: 'not-a-file'
    })
  })

  it('skips a combined diff tab', () => {
    expect(
      resolveLspDocumentRef(tab({ combinedAlternate: { kind: 'branch' } }), WORKSPACES).ok
    ).toBe(false)
  })

  it('skips an untitled buffer with no path on disk', () => {
    expect(resolveLspDocumentRef(tab({ isUntitled: true }), WORKSPACES).ok).toBe(false)
  })

  it('skips a check-run tab, which is fetched CI metadata', () => {
    expect(resolveLspDocumentRef(tab({ checkRunDetails: {} }), WORKSPACES).ok).toBe(false)
  })

  it('skips a markdown preview tab that mirrors another file', () => {
    expect(
      resolveLspDocumentRef(tab({ markdownPreviewSourceFileId: 'other' }), WORKSPACES).ok
    ).toBe(false)
  })

  it('skips a file owned by a different SSH target than the workspace', () => {
    expect(
      resolveLspDocumentRef(tab({ externalSshTargetId: 'other-box' }), WORKSPACES).ok
    ).toBe(false)
  })

  it('skips an empty path', () => {
    expect(resolveLspDocumentRef(tab({ filePath: '' }), WORKSPACES).ok).toBe(false)
  })

  it('reports a missing workspace rather than guessing one', () => {
    expect(resolveLspDocumentRef(tab({ worktreeId: 'gone' }), WORKSPACES)).toEqual({
      ok: false,
      reason: 'no-workspace'
    })
  })

  it('refuses a file outside its workspace root', () => {
    expect(
      resolveLspDocumentRef(tab({ filePath: '/elsewhere/main.go' }), WORKSPACES)
    ).toEqual({ ok: false, reason: 'outside-workspace' })
  })

  it('does not treat a sibling directory with a shared prefix as inside', () => {
    // `/repo-backup` starts with `/repo` but is a different workspace.
    expect(
      resolveLspDocumentRef(tab({ filePath: '/repo-backup/main.go' }), WORKSPACES).ok
    ).toBe(false)
  })
})

describe('resolveLspDocumentRef path casing', () => {
  it('matches case-insensitively only when told to', () => {
    const windowsTab = tab({ filePath: 'C:/Repo/src/main.go', worktreeId: 'win' })
    const workspaces = [{ id: 'win', path: 'C:/repo' }]
    expect(resolveLspDocumentRef(windowsTab, workspaces).ok).toBe(false)
    expect(
      resolveLspDocumentRef(windowsTab, workspaces, { caseInsensitivePaths: true }).ok
    ).toBe(true)
  })

  it('accepts backslash paths against a forward-slash root', () => {
    const result = resolveLspDocumentRef(
      { filePath: 'C:\\repo\\src\\main.go', worktreeId: 'win', language: 'go' },
      [{ id: 'win', path: 'C:\\repo' }]
    )
    expect(result.ok).toBe(true)
  })
})
