import { describe, expect, it, vi } from 'vitest'
import type { LspDiagnostic } from '../../shared/lsp/lsp-protocol-types'
import { createDiagnosticsStore, type DiagnosticsStore } from './diagnostics-store'
import {
  buildDiagnosticTreeBadges,
  snapshotDiagnosticCounts,
  sortFileDiagnostics
} from '../../shared/lsp/workspace-diagnostics'

const ROOT = '/repo'

function diagnostic(message: string, severity?: 1 | 2 | 3 | 4, line = 0): LspDiagnostic {
  return {
    message,
    severity,
    range: { start: { line, character: 2 }, end: { line, character: 9 } }
  }
}

function publish(
  store: DiagnosticsStore,
  path: string,
  diagnostics: LspDiagnostic[],
  serverId = 'gopls'
): boolean {
  return store.publish({ rootPath: ROOT, serverId, path, diagnostics })
}

describe('createDiagnosticsStore publishing', () => {
  it('stores a diagnostic with its relative path and server tag', () => {
    const store = createDiagnosticsStore()
    publish(store, '/repo/src/main.go', [diagnostic('undefined: foo.Bar', 1)])
    expect(store.snapshot(ROOT).files).toEqual([
      {
        path: '/repo/src/main.go',
        relativePath: 'src/main.go',
        diagnostics: [expect.objectContaining({ message: 'undefined: foo.Bar', serverId: 'gopls' })]
      }
    ])
  })

  it('replaces a server previous findings for that file, not appends', () => {
    const store = createDiagnosticsStore()
    publish(store, '/repo/main.go', [diagnostic('first', 1)])
    publish(store, '/repo/main.go', [diagnostic('second', 1)])
    const [file] = store.snapshot(ROOT).files
    expect(file!.diagnostics.map((entry) => entry.message)).toEqual(['second'])
  })

  it('clears a file when its server publishes an empty set', () => {
    const store = createDiagnosticsStore()
    publish(store, '/repo/main.go', [diagnostic('boom', 1)])
    expect(publish(store, '/repo/main.go', [])).toBe(true)
    expect(store.snapshot(ROOT).files).toEqual([])
    expect(store.roots()).toEqual([])
  })

  it('reports no change when a server republishes an identical set', () => {
    const store = createDiagnosticsStore()
    publish(store, '/repo/main.go', [diagnostic('same', 2, 4)])
    // Servers republish on every keystroke; re-rendering four surfaces for an
    // unchanged set is the waste this guard exists to avoid.
    expect(publish(store, '/repo/main.go', [diagnostic('same', 2, 4)])).toBe(false)
  })

  it('reports a change when only the range moved', () => {
    const store = createDiagnosticsStore()
    publish(store, '/repo/main.go', [diagnostic('same', 2, 4)])
    expect(publish(store, '/repo/main.go', [diagnostic('same', 2, 9)])).toBe(true)
  })

  it('does not report a change for an empty publication to a clean file', () => {
    const store = createDiagnosticsStore()
    expect(publish(store, '/repo/main.go', [])).toBe(false)
  })

  it('caps runaway diagnostics for one file', () => {
    const store = createDiagnosticsStore({ maxDiagnosticsPerFile: 3 })
    publish(
      store,
      '/repo/generated.go',
      Array.from({ length: 50 }, (_, index) => diagnostic(`d${index}`, 1, index))
    )
    expect(store.snapshot(ROOT).files[0]!.diagnostics).toHaveLength(3)
  })
})

describe('createDiagnosticsStore multiple servers on one file', () => {
  it('keeps both servers findings', () => {
    const store = createDiagnosticsStore()
    publish(store, '/repo/a.ts', [diagnostic('type error', 1)], 'typescript')
    publish(store, '/repo/a.ts', [diagnostic('lint warning', 2)], 'eslint')
    const [file] = store.snapshot(ROOT).files
    expect(file!.diagnostics.map((entry) => entry.serverId).sort()).toEqual([
      'eslint',
      'typescript'
    ])
  })

  it('does not let one server clean publication erase the other', () => {
    const store = createDiagnosticsStore()
    publish(store, '/repo/a.ts', [diagnostic('type error', 1)], 'typescript')
    publish(store, '/repo/a.ts', [diagnostic('lint warning', 2)], 'eslint')
    publish(store, '/repo/a.ts', [], 'typescript')
    const [file] = store.snapshot(ROOT).files
    expect(file!.diagnostics.map((entry) => entry.message)).toEqual(['lint warning'])
  })
})

describe('createDiagnosticsStore staleness', () => {
  it('clears every server for a closed document', () => {
    const store = createDiagnosticsStore()
    publish(store, '/repo/a.ts', [diagnostic('one', 1)], 'typescript')
    publish(store, '/repo/a.ts', [diagnostic('two', 2)], 'eslint')
    expect(store.clearFile(ROOT, '/repo/a.ts')).toBe(true)
    expect(store.snapshot(ROOT).files).toEqual([])
  })

  it('clears one server across every file when it stops', () => {
    const store = createDiagnosticsStore()
    publish(store, '/repo/a.go', [diagnostic('a', 1)], 'gopls')
    publish(store, '/repo/b.go', [diagnostic('b', 1)], 'gopls')
    publish(store, '/repo/c.ts', [diagnostic('c', 1)], 'typescript')
    expect(store.clearServer(ROOT, 'gopls')).toBe(true)
    expect(store.snapshot(ROOT).files.map((file) => file.relativePath)).toEqual(['c.ts'])
  })

  it('clears a whole workspace', () => {
    const store = createDiagnosticsStore()
    publish(store, '/repo/a.go', [diagnostic('a', 1)])
    expect(store.clearWorkspace(ROOT)).toBe(true)
    expect(store.roots()).toEqual([])
  })

  it('reports no change when clearing something already clean', () => {
    const store = createDiagnosticsStore()
    expect(store.clearFile(ROOT, '/repo/absent.go')).toBe(false)
    expect(store.clearServer(ROOT, 'gopls')).toBe(false)
    expect(store.clearWorkspace(ROOT)).toBe(false)
  })

  it('keeps workspaces independent', () => {
    const store = createDiagnosticsStore()
    store.publish({ rootPath: '/repo', serverId: 'gopls', path: '/repo/a.go', diagnostics: [diagnostic('a', 1)] })
    store.publish({ rootPath: '/other', serverId: 'gopls', path: '/other/b.go', diagnostics: [diagnostic('b', 1)] })
    store.clearWorkspace('/repo')
    expect(store.roots()).toEqual(['/other'])
  })
})

describe('createDiagnosticsStore subscriptions', () => {
  it('notifies subscribers with the snapshot for the changed root', () => {
    const store = createDiagnosticsStore()
    const listener = vi.fn()
    store.subscribe(listener)
    publish(store, '/repo/main.go', [diagnostic('boom', 1)])
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ rootPath: ROOT, files: expect.any(Array) })
    )
  })

  it('stops notifying after unsubscribe', () => {
    const store = createDiagnosticsStore()
    const listener = vi.fn()
    store.subscribe(listener)()
    publish(store, '/repo/main.go', [diagnostic('boom', 1)])
    expect(listener).not.toHaveBeenCalled()
  })

  it('notifies on every staleness path so no reader keeps a stale marker', () => {
    const store = createDiagnosticsStore()
    publish(store, '/repo/main.go', [diagnostic('boom', 1)])
    const listener = vi.fn()
    store.subscribe(listener)
    store.clearFile(ROOT, '/repo/main.go')
    publish(store, '/repo/main.go', [diagnostic('boom', 1)])
    store.clearServer(ROOT, 'gopls')
    publish(store, '/repo/main.go', [diagnostic('boom', 1)])
    store.clearWorkspace(ROOT)
    // Five mutations — close, republish, server stop, republish, workspace
    // close — and a notification for each, so no surface keeps a stale marker.
    expect(listener).toHaveBeenCalledTimes(5)
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ files: [] }))
  })
})

describe('diagnostic rollups', () => {
  it('counts by severity across the workspace', () => {
    const store = createDiagnosticsStore()
    publish(store, '/repo/a.go', [diagnostic('e', 1), diagnostic('w', 2, 3)])
    publish(store, '/repo/b.go', [diagnostic('i', 3), diagnostic('h', 4, 2)])
    expect(snapshotDiagnosticCounts(store.snapshot(ROOT))).toEqual({
      error: 1,
      warning: 1,
      information: 1,
      hint: 1
    })
  })

  it('treats a severity-less diagnostic as an error, per the LSP default', () => {
    const store = createDiagnosticsStore()
    publish(store, '/repo/a.go', [diagnostic('no severity')])
    expect(snapshotDiagnosticCounts(store.snapshot(ROOT)).error).toBe(1)
  })

  it('propagates the worst severity to every ancestor directory', () => {
    const store = createDiagnosticsStore()
    publish(store, '/repo/src/service/auction.go', [diagnostic('e', 1)])
    publish(store, '/repo/src/handler/handler.go', [diagnostic('w', 2)])
    const badges = buildDiagnosticTreeBadges(store.snapshot(ROOT))
    expect(badges.files.get('src/service/auction.go')).toBe('error')
    expect(badges.directories.get('src/service')).toBe('error')
    expect(badges.directories.get('src/handler')).toBe('warning')
    // `src/` holds both, so the worse one wins and a collapsed folder still warns.
    expect(badges.directories.get('src')).toBe('error')
    expect(badges.directories.get('')).toBe('error')
  })

  it('orders the Problems panel worst-first, then by path and position', () => {
    const store = createDiagnosticsStore()
    publish(store, '/repo/z-warn.go', [diagnostic('w', 2)])
    publish(store, '/repo/a-err.go', [diagnostic('late', 1, 20), diagnostic('early', 1, 2)])
    const sorted = sortFileDiagnostics(store.snapshot(ROOT).files)
    expect(sorted.map((file) => file.relativePath)).toEqual(['a-err.go', 'z-warn.go'])
    expect(sorted[0]!.diagnostics.map((entry) => entry.message)).toEqual(['early', 'late'])
  })
})

describe('createDiagnosticsStore path normalization', () => {
  it('relativizes Windows paths with forward slashes', () => {
    const store = createDiagnosticsStore({ caseInsensitivePaths: true })
    store.publish({
      rootPath: 'C:\\repo',
      serverId: 'gopls',
      path: 'C:\\Repo\\src\\main.go',
      diagnostics: [diagnostic('boom', 1)]
    })
    expect(store.snapshot('C:\\repo').files[0]!.relativePath).toBe('src/main.go')
  })

  it('keeps a path outside the workspace absolute rather than faking it in', () => {
    const store = createDiagnosticsStore()
    store.publish({
      rootPath: '/repo',
      serverId: 'gopls',
      path: '/home/user/go/pkg/mod/dep/lib.go',
      diagnostics: [diagnostic('boom', 1)]
    })
    expect(store.snapshot('/repo').files[0]!.relativePath).toBe(
      '/home/user/go/pkg/mod/dep/lib.go'
    )
  })
})
