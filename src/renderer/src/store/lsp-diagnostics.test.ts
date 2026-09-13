import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceDiagnosticsSnapshot } from '../../../shared/lsp/workspace-diagnostics'
import {
  resetLspDiagnosticsSubscriptionForTests,
  selectFileDiagnostics,
  selectServerStatuses,
  selectTreeBadges,
  selectWorkspaceCounts,
  selectWorkspaceDiagnostics,
  startLspDiagnosticsSubscription,
  useLspDiagnosticsStore
} from './lsp-diagnostics'

function snapshot(rootPath: string, paths: string[]): WorkspaceDiagnosticsSnapshot {
  return {
    rootPath,
    files: paths.map((relativePath) => ({
      path: `${rootPath}/${relativePath}`,
      relativePath,
      diagnostics: [
        {
          serverId: 'gopls',
          message: `problem in ${relativePath}`,
          severity: 1,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }
        }
      ]
    }))
  }
}

type LanguageServerStub = {
  diagnostics: ReturnType<typeof vi.fn>
  onDiagnosticsChanged: ReturnType<typeof vi.fn>
  onStatusChanged: ReturnType<typeof vi.fn>
}

let stub: LanguageServerStub
let diagnosticsListener: ((snapshot: WorkspaceDiagnosticsSnapshot) => void) | null

beforeEach(() => {
  diagnosticsListener = null
  stub = {
    diagnostics: vi.fn(async (rootPath: string) => snapshot(rootPath, ['loaded.go'])),
    onDiagnosticsChanged: vi.fn((callback) => {
      diagnosticsListener = callback
      return () => {}
    }),
    onStatusChanged: vi.fn(() => () => {})
  }
  ;(globalThis as { window?: unknown }).window = { api: { languageServers: stub } }
  resetLspDiagnosticsSubscriptionForTests()
})

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

describe('useLspDiagnosticsStore', () => {
  it('mirrors a pushed snapshot', () => {
    useLspDiagnosticsStore.getState().applySnapshot(snapshot('/repo', ['main.go']))
    expect(selectWorkspaceDiagnostics(useLspDiagnosticsStore.getState(), '/repo').files).toHaveLength(
      1
    )
  })

  it('replaces a workspace snapshot rather than merging it', () => {
    const store = useLspDiagnosticsStore.getState()
    store.applySnapshot(snapshot('/repo', ['a.go', 'b.go']))
    store.applySnapshot(snapshot('/repo', ['a.go']))
    expect(
      selectWorkspaceDiagnostics(useLspDiagnosticsStore.getState(), '/repo').files.map(
        (file) => file.relativePath
      )
    ).toEqual(['a.go'])
  })

  it('applies an empty snapshot so fixed files lose their markers', () => {
    const store = useLspDiagnosticsStore.getState()
    store.applySnapshot(snapshot('/repo', ['main.go']))
    store.applySnapshot({ rootPath: '/repo', files: [] })
    expect(selectWorkspaceDiagnostics(useLspDiagnosticsStore.getState(), '/repo').files).toEqual([])
  })

  it('skips the write when a clean workspace reports clean again', () => {
    let writes = 0
    const unsubscribe = useLspDiagnosticsStore.subscribe(() => {
      writes += 1
    })
    useLspDiagnosticsStore.getState().applySnapshot({ rootPath: '/never-seen', files: [] })
    unsubscribe()
    expect(writes).toBe(0)
  })

  it('keeps workspaces independent', () => {
    const store = useLspDiagnosticsStore.getState()
    store.applySnapshot(snapshot('/repo', ['a.go']))
    store.applySnapshot(snapshot('/other', ['b.go']))
    store.forgetWorkspace('/repo')
    const state = useLspDiagnosticsStore.getState()
    expect(selectWorkspaceDiagnostics(state, '/repo').files).toEqual([])
    expect(selectWorkspaceDiagnostics(state, '/other').files).toHaveLength(1)
  })

  it('returns an empty snapshot for a null root instead of throwing', () => {
    expect(selectWorkspaceDiagnostics(useLspDiagnosticsStore.getState(), null).files).toEqual([])
    expect(selectWorkspaceCounts(useLspDiagnosticsStore.getState(), undefined).error).toBe(0)
    expect(selectServerStatuses(useLspDiagnosticsStore.getState(), null)).toEqual([])
  })
})

describe('selectors', () => {
  beforeEach(() => {
    useLspDiagnosticsStore
      .getState()
      .applySnapshot(snapshot('/repo', ['src/service/auction.go', 'src/handler/handler.go']))
  })

  it('finds one file diagnostics by absolute path', () => {
    const file = selectFileDiagnostics(
      useLspDiagnosticsStore.getState(),
      '/repo',
      '/repo/src/service/auction.go'
    )
    expect(file?.relativePath).toBe('src/service/auction.go')
  })

  it('returns null for a file with none', () => {
    expect(
      selectFileDiagnostics(useLspDiagnosticsStore.getState(), '/repo', '/repo/clean.go')
    ).toBeNull()
  })

  it('counts by severity for the summary chip', () => {
    expect(selectWorkspaceCounts(useLspDiagnosticsStore.getState(), '/repo')).toMatchObject({
      error: 2,
      warning: 0
    })
  })

  it('builds explorer badges propagated to ancestors', () => {
    const badges = selectTreeBadges(useLspDiagnosticsStore.getState(), '/repo')
    expect(badges.files.get('src/service/auction.go')).toBe('error')
    expect(badges.directories.get('src')).toBe('error')
  })
})

describe('startLspDiagnosticsSubscription', () => {
  it('binds once even when several surfaces ask', () => {
    startLspDiagnosticsSubscription()
    startLspDiagnosticsSubscription()
    // A second binding would double every marker update.
    expect(stub.onDiagnosticsChanged).toHaveBeenCalledTimes(1)
    expect(stub.onStatusChanged).toHaveBeenCalledTimes(1)
  })

  it('routes a pushed snapshot into the store', () => {
    startLspDiagnosticsSubscription()
    diagnosticsListener?.(snapshot('/repo', ['pushed.go']))
    expect(
      selectWorkspaceDiagnostics(useLspDiagnosticsStore.getState(), '/repo').files[0]?.relativePath
    ).toBe('pushed.go')
  })

  it('does nothing without the preload namespace', () => {
    ;(globalThis as { window?: unknown }).window = { api: {} }
    resetLspDiagnosticsSubscriptionForTests()
    expect(() => startLspDiagnosticsSubscription()).not.toThrow()
  })
})

describe('loadWorkspace', () => {
  it('pulls the current snapshot for a newly opened workspace', async () => {
    await useLspDiagnosticsStore.getState().loadWorkspace('/repo')
    expect(stub.diagnostics).toHaveBeenCalledWith('/repo')
    expect(
      selectWorkspaceDiagnostics(useLspDiagnosticsStore.getState(), '/repo').files[0]?.relativePath
    ).toBe('loaded.go')
  })

  it('survives main not being ready', async () => {
    stub.diagnostics.mockRejectedValueOnce(new Error('not ready'))
    await expect(
      useLspDiagnosticsStore.getState().loadWorkspace('/repo')
    ).resolves.toBeUndefined()
  })

  it('is a no-op without the preload namespace', async () => {
    ;(globalThis as { window?: unknown }).window = { api: {} }
    await expect(
      useLspDiagnosticsStore.getState().loadWorkspace('/repo')
    ).resolves.toBeUndefined()
  })
})
