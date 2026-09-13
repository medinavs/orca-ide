/**
 * One language server, one workspace root: handshake, document sync, lifecycle.
 *
 * Deliberately language-agnostic — everything server-specific arrives in the
 * `LanguageServerSpec`. `create` never throws: "gopls is not installed" is a
 * status the UI renders, not an error the editor should swallow.
 */
import { pathToFileURL } from 'node:url'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createOutputSink } from '../../shared/child-process/bounded-output-sink'
import {
  createLspConnection,
  LspConnectionClosedError,
  type LspConnection
} from '../../shared/lsp/lsp-connection'
import type { LanguageServerSpec } from '../../shared/lsp/language-server-catalog'
import {
  textDocumentSyncKind,
  type LspInitializeResult,
  type LspServerCapabilities
} from '../../shared/lsp/lsp-protocol-types'
import { ORCA_LSP_CLIENT_CAPABILITIES } from './language-server-client-capabilities'
import {
  createLanguageServerDocuments,
  type LanguageServerDocuments
} from './language-server-documents'
import {
  installServerRequestHandlers,
  spawnLanguageServer,
  type LanguageServerSpawn,
  type ServerDiagnosticsPublication
} from './language-server-transport'
import type { LanguageServerStatus } from '../../shared/lsp/language-server-status'
import { createPullDiagnostics } from './language-server-pull-diagnostics'
export type {
  LanguageServerState,
  LanguageServerStatus
} from '../../shared/lsp/language-server-status'

const STDERR_TAIL_BYTES = 16 * 1024
const INITIALIZE_TIMEOUT_MS = 60_000
const SHUTDOWN_GRACE_MS = 3_000

export type LanguageServerSessionOptions = {
  spec: LanguageServerSpec
  rootPath: string
  restarts?: number
  env?: NodeJS.ProcessEnv
  onDiagnostics?: (publication: ServerDiagnosticsPublication) => void
  onStatus?: (status: LanguageServerStatus) => void
  onLog?: (line: string) => void
  onUnexpectedExit?: (status: LanguageServerStatus) => void
  /** Seam for tests; defaults to the real stdio spawn. */
  spawn?: (
    spec: LanguageServerSpec,
    rootPath: string,
    env: NodeJS.ProcessEnv
  ) => LanguageServerSpawn
}

export type LanguageServerSession = {
  status(): LanguageServerStatus
  /** Resolves when the handshake completes; rejects if it cannot. */
  ready(): Promise<LspServerCapabilities>
  openDocument(path: string, languageId: string, text: string): void
  changeDocument(path: string, text: string): void
  closeDocument(path: string): void
  saveDocument(path: string): void
  isDocumentOpen(path: string): boolean
  /** Enough to reopen every document on a replacement session after a crash. */
  openDocuments(): { path: string; languageId: string; text: string }[]
  /** Raw request against the live connection; rejects when not running. */
  request<T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T>
  stop(reason: string): Promise<void>
}

export function createLanguageServerSession(
  options: LanguageServerSessionOptions
): LanguageServerSession {
  const { spec, rootPath } = options
  const env = options.env ?? process.env
  const stderr = createOutputSink(STDERR_TAIL_BYTES)
  let status: LanguageServerStatus = {
    serverId: spec.id,
    label: spec.label,
    rootPath,
    state: 'starting',
    restarts: options.restarts ?? 0
  }
  let connection: LspConnection | null = null
  let child: ChildProcessWithoutNullStreams | null = null
  let syncKind: 0 | 1 | 2 = 1
  let stopping = false
  let stopPromise: Promise<void> | null = null
  let readySettled = false
  let readyResolve: ((capabilities: LspServerCapabilities) => void) | null = null
  let readyReject: ((error: Error) => void) | null = null
  const readyPromise = new Promise<LspServerCapabilities>((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })
  // Why: a rejected `ready()` nobody awaited is an unhandled rejection that
  // takes the main process down, and the manager may legitimately never ask.
  readyPromise.catch(() => {})
  const documents: LanguageServerDocuments = createLanguageServerDocuments({
    connection: () => liveConnection(),
    syncKind: () => syncKind,
    onChange: () => pullDiagnostics.refresh()
  })
  const pullDiagnostics = createPullDiagnostics({
    connection: () => (status.capabilities?.diagnosticProvider ? liveConnection() : null),
    documents,
    publish: options.onDiagnostics,
    onLog: options.onLog
  })

  function publishStatus(next: Partial<LanguageServerStatus>): void {
    status = { ...status, ...next }
    options.onStatus?.(status)
  }

  function settleReady(capabilities: LspServerCapabilities | null, error?: Error): void {
    if (readySettled) {
      return
    }
    readySettled = true
    if (capabilities) {
      readyResolve?.(capabilities)
      return
    }
    readyReject?.(error ?? new Error('language server did not start'))
  }

  function fail(state: 'failed' | 'not-installed' | 'stopped', message: string): void {
    const notInstalled = state === 'not-installed'
    publishStatus({
      state,
      message,
      stderrTail: stderr.text() || undefined,
      installHint: notInstalled ? spec.installHint : undefined,
      documentationUrl: notInstalled ? spec.documentationUrl : undefined
    })
    settleReady(null, new Error(message))
  }

  const uriFor = (path: string): string => pathToFileURL(path).href

  function start(): void {
    const spawned = (options.spawn ?? spawnLanguageServer)(spec, rootPath, env)
    if (!spawned.ok) {
      fail(spawned.reason === 'not-installed' ? 'not-installed' : 'failed', spawned.message)
      return
    }
    child = spawned.child
    const active = createLspConnection({
      transport: { write: (data) => void spawned.child.stdin.write(data) },
      onProtocolError: (error, fatal) => {
        options.onLog?.(`[${spec.label}] protocol error: ${error}`)
        if (fatal) {
          fail('failed', `${spec.label} sent output that is not LSP: ${error}`)
          void stop(`protocol error: ${error}`)
        }
      }
    })
    connection = active
    active.onRequest('workspace/diagnostic/refresh', () => {
      pullDiagnostics.refresh()
      return null
    })
    installServerRequestHandlers(active, {
      documentPaths: documents.paths,
      label: spec.label,
      onLog: options.onLog,
      onDiagnostics: options.onDiagnostics
    })
    wireProcess(spawned.child, active)
    void initialize(active)
  }

  function wireProcess(process_: ChildProcessWithoutNullStreams, active: LspConnection): void {
    process_.stdout.on('data', (chunk: Buffer) => active.handleData(chunk))
    process_.stderr.on('data', (chunk: Buffer) => {
      stderr.write(chunk)
      options.onLog?.(`[${spec.label}] ${chunk.toString('utf8').trimEnd()}`)
    })
    // An unhandled stream 'error' is an uncaught exception in the main process.
    process_.stdin.on('error', () => {})
    process_.on('error', (error) => fail('failed', `${spec.label} failed: ${error.message}`))
    process_.on('exit', (code, signal) => {
      active.close(`process exited (${code ?? signal})`)
      if (connection === active) {
        connection = null
        child = null
      }
      if (stopping) {
        return
      }
      fail(
        'failed',
        `${spec.label} exited unexpectedly (code ${code ?? 'none'}, signal ${signal ?? 'none'}).`
      )
      options.onUnexpectedExit?.(status)
    })
  }

  async function initialize(active: LspConnection): Promise<void> {
    try {
      const result = await active.request<LspInitializeResult>(
        'initialize',
        {
          processId: process.pid,
          clientInfo: { name: 'Orca' },
          rootUri: uriFor(rootPath),
          workspaceFolders: [{ uri: uriFor(rootPath), name: rootPath }],
          capabilities: ORCA_LSP_CLIENT_CAPABILITIES,
          initializationOptions: spec.initializationOptions
        },
        AbortSignal.timeout(INITIALIZE_TIMEOUT_MS)
      )
      const capabilities = result?.capabilities ?? {}
      syncKind = textDocumentSyncKind(capabilities)
      active.notify('initialized', {})
      active.notify('workspace/didChangeConfiguration', { settings: {} })
      publishStatus({
        state: 'running',
        capabilities,
        serverInfo: result?.serverInfo,
        message: undefined
      })
      settleReady(capabilities)
      // Documents opened while the handshake was in flight are sent now, in
      // arrival order, so the server never sees a change before its open.
      for (const [path, document] of documents.entries()) {
        active.notify('textDocument/didOpen', {
          textDocument: {
            uri: uriFor(path),
            languageId: document.languageId,
            version: document.version,
            text: document.text
          }
        })
      }
      pullDiagnostics.refresh()
    } catch (error) {
      // A closed connection means the exit handler already set the status.
      if (error instanceof LspConnectionClosedError) {
        return
      }
      fail('failed', `${spec.label} did not complete initialization: ${String(error)}`)
      void stop('initialization failed')
    }
  }

  const liveConnection = (): LspConnection | null =>
    !stopping && status.state === 'running' ? connection : null

  // Why memoized rather than a boolean: a second caller must await the same
  // termination, not return early while the process is still alive. App
  // shutdown and a protocol-error teardown race exactly this way.
  function stop(reason: string): Promise<void> {
    stopPromise ??= runStop(reason)
    return stopPromise
  }

  async function runStop(reason: string): Promise<void> {
    stopping = true
    pullDiagnostics.cancel()
    const active = connection
    const process_ = child
    if (active && status.state === 'running') {
      try {
        // A server that will not answer shutdown gets signalled below instead.
        await Promise.race([
          active.request('shutdown'),
          new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS))
        ])
        active.notify('exit')
      } catch {
        /* fall through to termination */
      }
    }
    active?.close(reason)
    connection = null
    // Keep buffers until replacement so edits and closes during shutdown survive restart.
    if (process_ && process_.exitCode === null) {
      await terminate(process_)
    }
    if (status.state !== 'failed' && status.state !== 'not-installed') {
      publishStatus({ state: 'stopped', message: reason })
    }
    settleReady(null, new Error(`stopped: ${reason}`))
  }

  /**
   * `kill` can throw even after an `exitCode === null` check: the child may
   * exit in between, and Windows then answers EINVAL for the reaped pid. An
   * already-dead process is the outcome we wanted, so the throw is swallowed
   * rather than failing app shutdown.
   */
  function signal(process_: ChildProcessWithoutNullStreams, name?: NodeJS.Signals): void {
    try {
      process_.kill(name)
    } catch {
      /* already gone */
    }
  }

  function terminate(process_: ChildProcessWithoutNullStreams): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        signal(process_, 'SIGKILL')
        resolve()
      }, SHUTDOWN_GRACE_MS)
      process_.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      signal(process_)
    })
  }

  // Published before the first spawn attempt so a subscriber that just
  // subscribed sees `starting` immediately — the UI needs something to show
  // during a cold gopls start, which can take seconds on a large module.
  options.onStatus?.(status)
  start()

  return {
    status: () => status,
    ready: () => readyPromise,

    openDocument: documents.open,
    changeDocument: documents.change,
    closeDocument: documents.close,
    saveDocument: documents.save,
    isDocumentOpen: documents.isOpen,
    openDocuments: () =>
      documents
        .entries()
        .map(([path, record]) => ({ path, languageId: record.languageId, text: record.text })),

    request<T>(method, params, signal) {
      const active = liveConnection()
      if (!active) {
        return Promise.reject(
          new Error(status.message ?? `${spec.label} is not running (${status.state}).`)
        )
      }
      return active.request<T>(method, params, signal)
    },

    stop
  }
}
