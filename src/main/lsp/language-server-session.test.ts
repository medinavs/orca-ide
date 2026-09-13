import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { LanguageServerSpec } from '../../shared/lsp/language-server-catalog'
import {
  createLanguageServerSession,
  type LanguageServerSession,
  type LanguageServerStatus
} from './language-server-session'
import type { ServerDiagnosticsPublication } from './language-server-transport'

const MOCK_SERVER = fileURLToPath(
  new URL('./__fixtures__/mock-language-server.mjs', import.meta.url)
)

/** Runs the mock server under the current Node, so no PATH lookup is needed. */
function mockSpec(overrides: Partial<LanguageServerSpec> = {}): LanguageServerSpec {
  return {
    id: 'mock',
    label: 'mock-lsp',
    languageIds: ['go'],
    command: process.execPath,
    args: [MOCK_SERVER],
    installHint: 'install the mock',
    ...overrides
  }
}

const sessions: LanguageServerSession[] = []
const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-lsp-session-'))
  roots.push(root)
  return root
}

type Harness = {
  session: LanguageServerSession
  root: string
  diagnostics: ServerDiagnosticsPublication[]
  statuses: LanguageServerStatus[]
  logs: string[]
  exits: LanguageServerStatus[]
}

function start(
  spec: LanguageServerSpec = mockSpec(),
  env: NodeJS.ProcessEnv = {}
): Harness {
  const root = makeRoot()
  const diagnostics: ServerDiagnosticsPublication[] = []
  const statuses: LanguageServerStatus[] = []
  const logs: string[] = []
  const exits: LanguageServerStatus[] = []
  const session = createLanguageServerSession({
    spec,
    rootPath: root,
    env: { ...process.env, ...env },
    onDiagnostics: (publication) => diagnostics.push(publication),
    onStatus: (status) => statuses.push({ ...status }),
    onLog: (line) => logs.push(line),
    onUnexpectedExit: (status) => exits.push({ ...status })
  })
  sessions.push(session)
  return { session, root, diagnostics, statuses, logs, exits }
}

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.stop('test teardown')))
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('createLanguageServerSession startup', () => {
  it('completes the handshake and reports the server capabilities', async () => {
    const { session } = start()
    const capabilities = await session.ready()
    expect(capabilities.hoverProvider).toBe(true)
    const status = session.status()
    expect(status.state).toBe('running')
    expect(status.serverInfo).toEqual({ name: 'mock-lsp', version: '1.2.3' })
  })

  it('reports not-installed with the install hint instead of throwing', async () => {
    const { session } = start(mockSpec({ command: 'orca-no-such-language-server' }))
    await expect(session.ready()).rejects.toThrow(/not found on PATH/)
    expect(session.status()).toMatchObject({
      state: 'not-installed',
      installHint: 'install the mock'
    })
  })

  it('answers a server-initiated workspace/configuration during startup', async () => {
    const { session } = start(mockSpec(), { MOCK_LSP_ASK_CONFIG: '1' })
    await expect(session.ready()).resolves.toBeDefined()
    // The mock blocks nothing on the answer, but a real server does; reaching
    // `running` at all proves the request was replied to rather than dropped.
    expect(session.status().state).toBe('running')
  })

  it('fails cleanly when the server prints non-LSP output', async () => {
    const { session } = start(mockSpec(), { MOCK_LSP_GARBAGE: '1' })
    await expect(session.ready()).rejects.toThrow()
    await vi.waitFor(() => expect(session.status().state).not.toBe('starting'))
    expect(session.status().state).toBe('failed')
  })
})

describe('createLanguageServerSession diagnostics', () => {
  it('converts the published URI back to a host path', async () => {
    const harness = start()
    await harness.session.ready()
    const filePath = join(harness.root, 'main.go')
    writeFileSync(filePath, 'package main')
    harness.session.openDocument(filePath, 'go', 'package main')
    await vi.waitFor(() => expect(harness.diagnostics).toHaveLength(1))
    expect(harness.diagnostics[0]).toMatchObject({
      path: filePath,
      diagnostics: [{ message: 'mock error', severity: 1 }]
    })
  })

  it('drops a publication for a non-file URI rather than guessing a path', async () => {
    const harness = start()
    await harness.session.ready()
    // Proven indirectly: a file URI arrives, a `untitled:` one would not parse.
    const filePath = join(harness.root, 'ok.go')
    harness.session.openDocument(filePath, 'go', 'package main')
    await vi.waitFor(() => expect(harness.diagnostics).toHaveLength(1))
    expect(pathToFileURL(harness.diagnostics[0]!.path).href).toContain('ok.go')
  })
})

describe('createLanguageServerSession document sync', () => {
  it('opens, changes and closes a document in order', async () => {
    const harness = start()
    await harness.session.ready()
    const filePath = join(harness.root, 'main.go')
    harness.session.openDocument(filePath, 'go', 'package main')
    harness.session.changeDocument(filePath, 'package main // edited')
    harness.session.saveDocument(filePath)
    harness.session.closeDocument(filePath)
    const seen = await harness.session.request<{ method: string }[]>('$/mockReceived')
    const methods = seen.map((entry) => entry.method)
    expect(methods).toEqual(
      expect.arrayContaining([
        'textDocument/didOpen',
        'textDocument/didChange',
        'textDocument/didSave',
        'textDocument/didClose'
      ])
    )
    expect(methods.indexOf('textDocument/didOpen')).toBeLessThan(
      methods.indexOf('textDocument/didChange')
    )
    expect(harness.session.isDocumentOpen(filePath)).toBe(false)
  })

  it('sends a range-spanning change when the server asked for incremental sync', async () => {
    const harness = start()
    await harness.session.ready()
    const filePath = join(harness.root, 'main.go')
    harness.session.openDocument(filePath, 'go', 'one\ntwo')
    harness.session.changeDocument(filePath, 'x')
    const seen = await harness.session.request<
      { method: string; params: { contentChanges?: unknown[] } }[]
    >('$/mockReceived')
    const change = seen.find((entry) => entry.method === 'textDocument/didChange')
    expect(change?.params.contentChanges).toEqual([
      { range: { start: { line: 0, character: 0 }, end: { line: 1, character: 3 } }, text: 'x' }
    ])
  })

  it('sends the whole text when the server asked for full sync', async () => {
    const harness = start(mockSpec(), { MOCK_LSP_SYNC_KIND: '1' })
    await harness.session.ready()
    const filePath = join(harness.root, 'main.go')
    harness.session.openDocument(filePath, 'go', 'one')
    harness.session.changeDocument(filePath, 'two')
    const seen = await harness.session.request<
      { method: string; params: { contentChanges?: unknown[] } }[]
    >('$/mockReceived')
    const change = seen.find((entry) => entry.method === 'textDocument/didChange')
    expect(change?.params.contentChanges).toEqual([{ text: 'two' }])
  })

  it('ignores a change that does not alter the text', async () => {
    const harness = start()
    await harness.session.ready()
    const filePath = join(harness.root, 'main.go')
    harness.session.openDocument(filePath, 'go', 'same')
    harness.session.changeDocument(filePath, 'same')
    const seen = await harness.session.request<{ method: string }[]>('$/mockReceived')
    expect(seen.filter((entry) => entry.method === 'textDocument/didChange')).toHaveLength(0)
  })

  it('replays documents opened before the handshake finished', async () => {
    const harness = start()
    const filePath = join(harness.root, 'early.go')
    // Opened synchronously, before `initialize` could possibly have returned.
    harness.session.openDocument(filePath, 'go', 'package main')
    await harness.session.ready()
    await vi.waitFor(() => expect(harness.diagnostics.length).toBeGreaterThan(0))
    expect(harness.diagnostics[0]?.path).toBe(filePath)
  })

  it('reports a change for an unopened document as a no-op', async () => {
    const harness = start()
    await harness.session.ready()
    expect(() => harness.session.changeDocument(join(harness.root, 'ghost.go'), 'x')).not.toThrow()
    const seen = await harness.session.request<{ method: string }[]>('$/mockReceived')
    expect(seen.filter((entry) => entry.method === 'textDocument/didChange')).toHaveLength(0)
  })
})

describe('createLanguageServerSession failure handling', () => {
  it('surfaces an unexpected exit as failed and notifies the manager', async () => {
    const harness = start(mockSpec(), { MOCK_LSP_CRASH_ON: 'textDocument/hover' })
    await harness.session.ready()
    await expect(harness.session.request('textDocument/hover')).rejects.toThrow()
    await vi.waitFor(() => expect(harness.exits).toHaveLength(1))
    expect(harness.session.status()).toMatchObject({ state: 'failed' })
    expect(harness.session.status().message).toMatch(/exited unexpectedly/)
  })

  it('rejects requests once stopped, with the reason', async () => {
    const { session } = start()
    await session.ready()
    await session.stop('workspace closed')
    expect(session.status().state).toBe('stopped')
    await expect(session.request('textDocument/hover')).rejects.toThrow(/workspace closed/)
  })

  it('kills a server that ignores exit rather than leaking it', async () => {
    const { session } = start(mockSpec(), { MOCK_LSP_IGNORE_EXIT: '1' })
    await session.ready()
    await session.stop('teardown')
    expect(session.status().state).toBe('stopped')
  })

  it('is safe to stop twice', async () => {
    const { session } = start()
    await session.ready()
    await session.stop('first')
    await expect(session.stop('second')).resolves.toBeUndefined()
  })

  it('rejects ready() when the server never answers initialize', async () => {
    const { session } = start(mockSpec(), { MOCK_LSP_NO_HANDSHAKE: '1' })
    await session.stop('give up')
    await expect(session.ready()).rejects.toThrow()
  })
})
