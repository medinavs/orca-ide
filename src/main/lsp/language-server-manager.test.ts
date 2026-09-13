import { describe, expect, it, vi } from 'vitest'
import { createDiagnosticsStore } from './diagnostics-store'
import type {
  LanguageServerOverrides,
  LanguageServerSpec
} from '../../shared/lsp/language-server-catalog'
import {
  createLanguageServerManager,
  LANGUAGE_SERVER_RESTART_LIMIT,
  type LanguageServerManager
} from './language-server-manager'
import type {
  LanguageServerSession,
  LanguageServerSessionOptions,
  LanguageServerStatus
} from './language-server-session'

type FakeSession = LanguageServerSession & {
  spec: LanguageServerSpec
  rootPath: string
  calls: string[]
  crash: () => void
  publish: (path: string, message: string) => void
  stopped: string[]
}

function createFakeSessionFactory(): {
  factory: (options: LanguageServerSessionOptions) => LanguageServerSession
  created: FakeSession[]
} {
  const created: FakeSession[] = []
  const factory = (options: LanguageServerSessionOptions): LanguageServerSession => {
    const calls: string[] = []
    const stopped: string[] = []
    const documents = new Map<string, { languageId: string; text: string }>()
    let status: LanguageServerStatus = {
      serverId: options.spec.id,
      label: options.spec.label,
      rootPath: options.rootPath,
      state: 'running',
      restarts: options.restarts ?? 0
    }
    const session: FakeSession = {
      spec: options.spec,
      rootPath: options.rootPath,
      calls,
      stopped,
      crash: () => {
        status = { ...status, state: 'failed', message: 'crashed' }
        options.onUnexpectedExit?.(status)
      },
      publish: (path, message) =>
        options.onDiagnostics?.({
          path,
          diagnostics: [
            { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message }
          ]
        }),
      status: () => status,
      ready: () => Promise.resolve({}),
      openDocument: (path, languageId, text) => {
        calls.push(`open ${path}`)
        documents.set(path, { languageId, text })
      },
      changeDocument: (path, text) => {
        calls.push(`change ${path}`)
        const existing = documents.get(path)
        if (existing) {
          documents.set(path, { ...existing, text })
        }
      },
      saveDocument: (path) => void calls.push(`save ${path}`),
      closeDocument: (path) => {
        calls.push(`close ${path}`)
        documents.delete(path)
      },
      isDocumentOpen: (path) => documents.has(path),
      openDocuments: () => [...documents.entries()].map(([path, record]) => ({ path, ...record })),
      request: () => Promise.resolve(undefined as never),
      stop: (reason) => {
        stopped.push(reason)
        status = { ...status, state: 'stopped' }
        return Promise.resolve()
      }
    }
    created.push(session)
    return session
  }
  return { factory, created }
}

function setup(overrides: Parameters<typeof createLanguageServerManager>[0] = {}): {
  manager: LanguageServerManager
  created: FakeSession[]
  logs: string[]
  diagnostics: unknown[]
} {
  const { factory, created } = createFakeSessionFactory()
  const logs: string[] = []
  const diagnostics: unknown[] = []
  const manager = createLanguageServerManager({
    createSession: factory,
    onLog: (line) => logs.push(line),
    onDiagnostics: (event) => diagnostics.push(event),
    ...overrides
  })
  return { manager, created, logs, diagnostics }
}

const GO_DOC = {
  executionHostId: 'local' as const,
  rootPath: '/repo',
  path: '/repo/main.go',
  languageId: 'go'
}

describe('createLanguageServerManager host boundary', () => {
  it('refuses an SSH workspace instead of starting a server locally', () => {
    const { manager, created } = setup()
    const result = manager.openDocument({ ...GO_DOC, executionHostId: 'ssh:box' }, 'package main')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.unavailable.state).toBe('unsupported-host')
    // The rule that matters: no silent local substitution for a remote repo.
    expect(created).toHaveLength(0)
  })

  it('refuses a runtime-environment workspace for the same reason', () => {
    const { manager, created } = setup()
    const result = manager.openDocument(
      { ...GO_DOC, executionHostId: 'runtime:env-1' },
      'package main'
    )
    expect(result.ok === false && result.unavailable.state).toBe('unsupported-host')
    expect(created).toHaveLength(0)
  })
})

describe('createLanguageServerManager session reuse', () => {
  it('starts one server per language and workspace, and reuses it', () => {
    const { manager, created } = setup()
    manager.openDocument(GO_DOC, 'package main')
    manager.openDocument({ ...GO_DOC, path: '/repo/other.go' }, 'package main')
    expect(created).toHaveLength(1)
    expect(created[0]!.calls).toEqual(['open /repo/main.go', 'open /repo/other.go'])
  })

  it('starts a separate server for a different workspace root', () => {
    const { manager, created } = setup()
    manager.openDocument(GO_DOC, '')
    manager.openDocument({ ...GO_DOC, rootPath: '/other', path: '/other/main.go' }, '')
    expect(created.map((session) => session.rootPath)).toEqual(['/repo', '/other'])
  })

  it('starts different servers for different languages side by side', () => {
    const { manager, created } = setup()
    manager.openDocument(GO_DOC, '')
    manager.openDocument({ ...GO_DOC, path: '/repo/a.ts', languageId: 'typescript' }, '')
    expect(created.map((session) => session.spec.id)).toEqual(['gopls', 'typescript'])
  })

  it('reports no-server for a language nothing claims', () => {
    const { manager, created } = setup()
    const result = manager.openDocument({ ...GO_DOC, languageId: 'markdown' }, '')
    expect(result.ok === false && result.unavailable.state).toBe('no-server')
    expect(created).toHaveLength(0)
  })

  it('honours a settings override that disables a server', () => {
    const { manager, created } = setup({ overrides: () => ({ gopls: { enabled: false } }) })
    expect(manager.openDocument(GO_DOC, '').ok).toBe(false)
    expect(created).toHaveLength(0)
  })

  it('reads overrides at start time, so a settings edit needs no restart', () => {
    let disabled = true
    const { manager, created } = setup({
      overrides: (): LanguageServerOverrides => (disabled ? { gopls: { enabled: false } } : {})
    })
    expect(manager.openDocument(GO_DOC, '').ok).toBe(false)
    disabled = false
    expect(manager.openDocument(GO_DOC, '').ok).toBe(true)
    expect(created).toHaveLength(1)
  })
})

describe('createLanguageServerManager document routing', () => {
  it('does not start a server for change, save or close', () => {
    const { manager, created } = setup()
    manager.changeDocument(GO_DOC, 'x')
    manager.saveDocument(GO_DOC)
    manager.closeDocument(GO_DOC)
    expect(created).toHaveLength(0)
  })

  it('routes edits to the running server', () => {
    const { manager, created } = setup()
    manager.openDocument(GO_DOC, 'package main')
    manager.changeDocument(GO_DOC, 'package main // x')
    manager.saveDocument(GO_DOC)
    manager.closeDocument(GO_DOC)
    expect(created[0]!.calls).toEqual([
      'open /repo/main.go',
      'change /repo/main.go',
      'save /repo/main.go',
      'close /repo/main.go'
    ])
  })

  it('tags diagnostics with the server that produced them', () => {
    const captured: { serverId: string; path: string }[] = []
    const { factory, created } = createFakeSessionFactory()
    const manager = createLanguageServerManager({
      createSession: factory,
      onDiagnostics: (event) => captured.push(event)
    })
    manager.openDocument(GO_DOC, '')
    created[0]!.publish('/repo/main.go', 'mock error')
    // The serverId is what lets a reader clear only one server's markers when
    // two servers publish for the same file.
    expect(captured).toEqual([
      expect.objectContaining({ serverId: 'gopls', path: '/repo/main.go' })
    ])
  })
})

describe('createLanguageServerManager crash recovery', () => {
  it('restarts a crashed server after a backoff and reopens its documents', async () => {
    vi.useFakeTimers()
    try {
      const { manager, created } = setup()
      manager.openDocument(GO_DOC, 'package main')
      created[0]!.crash()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(created).toHaveLength(2)
      expect(created[1]!.calls).toEqual(['open /repo/main.go'])
      expect(created[1]!.openDocuments()).toEqual([
        { path: '/repo/main.go', languageId: 'go', text: 'package main' }
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives up after the restart limit instead of looping forever', async () => {
    vi.useFakeTimers()
    try {
      const { manager, created, logs } = setup()
      manager.openDocument(GO_DOC, '')
      for (let attempt = 0; attempt <= LANGUAGE_SERVER_RESTART_LIMIT; attempt += 1) {
        created.at(-1)!.crash()
        await vi.advanceTimersByTimeAsync(10_000)
      }
      expect(created).toHaveLength(LANGUAGE_SERVER_RESTART_LIMIT + 1)
      expect(logs.some((line) => line.includes('gave up'))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not restart a server whose workspace closed during the backoff', async () => {
    vi.useFakeTimers()
    try {
      const { manager, created } = setup()
      manager.openDocument(GO_DOC, '')
      created[0]!.crash()
      await manager.stopWorkspace({ executionHostId: 'local', rootPath: '/repo' }, 'closed')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(created).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('createLanguageServerManager teardown', () => {
  it('restarts only the selected server and keeps edits and closes during shutdown', async () => {
    const { manager, created } = setup()
    manager.openDocument(GO_DOC, 'before')
    const other = { ...GO_DOC, path: '/repo/other.go' }
    manager.openDocument(other, 'close me')
    manager.openDocument({ ...GO_DOC, path: '/repo/a.ts', languageId: 'typescript' }, '')
    let finish!: () => void
    created[0]!.stop = () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
    const target = { ...GO_DOC, serverId: 'gopls' }
    const restart = manager.restart(target)
    expect(manager.restart(target)).toBe(restart)
    manager.changeDocument(GO_DOC, 'latest unsaved text')
    manager.closeDocument(other)
    finish()
    await restart
    expect(created).toHaveLength(3)
    expect(created[1]!.stopped).toEqual([])
    expect(created[2]!.openDocuments()).toEqual([
      { path: GO_DOC.path, languageId: 'go', text: 'latest unsaved text' }
    ])
    expect(created[2]!.status().restarts).toBe(0)
  })

  it('does not revive a workspace closed during a manual restart', async () => {
    const { manager, created } = setup()
    manager.openDocument(GO_DOC, '')
    const restart = manager.restart({ ...GO_DOC, serverId: 'gopls' })
    await manager.stopWorkspace(GO_DOC, 'closed')
    await restart
    expect(created).toHaveLength(1)
  })

  it('refuses remote restarts without touching a local server at the same path', async () => {
    const { manager, created } = setup()
    manager.openDocument(GO_DOC, '')
    await expect(
      manager.restart({ ...GO_DOC, executionHostId: 'ssh:box', serverId: 'gopls' })
    ).rejects.toThrow('remote host')
    expect(created[0]!.stopped).toEqual([])
  })

  it('stops only the named workspace', async () => {
    const { manager, created } = setup()
    manager.openDocument(GO_DOC, '')
    manager.openDocument({ ...GO_DOC, rootPath: '/other', path: '/other/main.go' }, '')
    await manager.stopWorkspace({ executionHostId: 'local', rootPath: '/repo' }, 'closed')
    expect(created[0]!.stopped).toEqual(['closed'])
    expect(created[1]!.stopped).toEqual([])
    expect(manager.statuses()).toHaveLength(1)
  })

  it('stops everything on shutdown', async () => {
    const { manager, created } = setup()
    manager.openDocument(GO_DOC, '')
    manager.openDocument({ ...GO_DOC, path: '/repo/a.ts', languageId: 'typescript' }, '')
    await manager.stopAll('quit')
    expect(created.every((session) => session.stopped.includes('quit'))).toBe(true)
    expect(manager.statuses()).toEqual([])
  })

  it('starts a fresh server after its workspace was stopped and reopened', async () => {
    const { manager, created } = setup()
    manager.openDocument(GO_DOC, '')
    await manager.stopWorkspace({ executionHostId: 'local', rootPath: '/repo' }, 'closed')
    manager.openDocument(GO_DOC, '')
    expect(created).toHaveLength(2)
  })

  it('reports the status of every live server', () => {
    const { manager } = setup()
    manager.openDocument(GO_DOC, '')
    expect(manager.statuses()).toEqual([
      expect.objectContaining({ serverId: 'gopls', state: 'running', rootPath: '/repo' })
    ])
  })
})

describe('createLanguageServerManager sessionFor', () => {
  it('does not start a server', () => {
    const { manager, created } = setup()
    expect(manager.sessionFor(GO_DOC).ok).toBe(false)
    expect(created).toHaveLength(0)
  })

  it('returns the running session once started', () => {
    const { manager } = setup()
    manager.openDocument(GO_DOC, '')
    expect(manager.sessionFor(GO_DOC).ok).toBe(true)
  })

  it('still refuses a remote host', () => {
    const { manager } = setup()
    const result = manager.sessionFor({ ...GO_DOC, executionHostId: 'ssh:box' })
    expect(result.ok === false && result.unavailable.state).toBe('unsupported-host')
  })
})

describe('createLanguageServerManager diagnostics store wiring', () => {
  function setupWithStore(): {
    manager: LanguageServerManager
    created: FakeSession[]
    store: ReturnType<typeof createDiagnosticsStore>
  } {
    const { factory, created } = createFakeSessionFactory()
    const store = createDiagnosticsStore()
    const manager = createLanguageServerManager({ createSession: factory, diagnostics: store })
    return { manager, created, store }
  }

  it('records a publication against the workspace root', () => {
    const { manager, created, store } = setupWithStore()
    manager.openDocument(GO_DOC, '')
    created[0]!.publish('/repo/main.go', 'undefined: foo.Bar')
    expect(store.snapshot('/repo').files).toEqual([
      expect.objectContaining({ relativePath: 'main.go' })
    ])
  })

  it('clears the file when the document closes', () => {
    const { manager, created, store } = setupWithStore()
    manager.openDocument(GO_DOC, '')
    created[0]!.publish('/repo/main.go', 'boom')
    manager.closeDocument(GO_DOC)
    expect(store.snapshot('/repo').files).toEqual([])
  })

  it('clears a crashed server markers rather than leaving them up', async () => {
    vi.useFakeTimers()
    try {
      const { manager, created, store } = setupWithStore()
      manager.openDocument(GO_DOC, '')
      created[0]!.publish('/repo/main.go', 'boom')
      created[0]!.crash()
      expect(store.snapshot('/repo').files).toEqual([])
      await vi.advanceTimersByTimeAsync(10_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears a workspace markers when it is stopped', async () => {
    const { manager, created, store } = setupWithStore()
    manager.openDocument(GO_DOC, '')
    created[0]!.publish('/repo/main.go', 'boom')
    await manager.stopWorkspace({ executionHostId: 'local', rootPath: '/repo' }, 'closed')
    expect(store.snapshot('/repo').files).toEqual([])
  })

  it('leaves another workspace markers alone when one stops', async () => {
    const { manager, created, store } = setupWithStore()
    manager.openDocument(GO_DOC, '')
    manager.openDocument({ ...GO_DOC, rootPath: '/other', path: '/other/main.go' }, '')
    created[0]!.publish('/repo/main.go', 'boom')
    created[1]!.publish('/other/main.go', 'boom')
    await manager.stopWorkspace({ executionHostId: 'local', rootPath: '/repo' }, 'closed')
    expect(store.snapshot('/other').files).toHaveLength(1)
  })
})
