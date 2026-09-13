/**
 * The stdio half of a language-server session: starting the process, and the
 * handlers for everything a server sends unprompted.
 *
 * Split from the session so the session file stays about lifecycle. The
 * server-to-client handlers live here because they are a fixed protocol
 * obligation rather than session policy — each one stalls a server's own
 * startup if it goes unanswered.
 */
import { fileURLToPath } from 'node:url'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawnProcess } from '../../shared/child-process/run-process'
import type { LspConnection } from '../../shared/lsp/lsp-connection'
import type { LanguageServerSpec } from '../../shared/lsp/language-server-catalog'
import type { LspPublishDiagnosticsParams } from '../../shared/lsp/lsp-protocol-types'
import { findExecutableOnPath } from './language-server-executable'
import { findNativeTypeScriptServer } from './typescript-native-server'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'

export type LanguageServerSpawn =
  | { ok: true; child: ChildProcessWithoutNullStreams; program: string }
  | { ok: false; reason: 'not-installed' | 'spawn-failed'; message: string }

export function spawnLanguageServer(
  spec: LanguageServerSpec,
  rootPath: string,
  env: NodeJS.ProcessEnv = process.env
): LanguageServerSpawn {
  const nativeTypeScript =
    spec.id === 'typescript' &&
    spec.command === 'typescript-language-server' &&
    spec.args.length === 1 &&
    spec.args[0] === '--stdio' &&
    !spec.initializationOptions?.tsserver
      ? findNativeTypeScriptServer(rootPath, env)
      : null
  const program = nativeTypeScript ?? findExecutableOnPath(spec.command, { env })
  if (program === null) {
    return {
      ok: false,
      reason: 'not-installed',
      message: `${spec.label} was not found on PATH.`
    }
  }
  try {
    const child = spawnProcess({
      program,
      args: nativeTypeScript ? ['--lsp', '--stdio'] : [...spec.args],
      cwd: rootPath,
      env,
      // A language server lives as long as the workspace is open.
      timeoutMs: null,
      stdio: 'pipe'
    })
    return { ok: true, child, program }
  } catch (error) {
    return {
      ok: false,
      reason: 'spawn-failed',
      message: `${spec.label} could not be started: ${String(error)}`
    }
  }
}

export type ServerDiagnosticsPublication = {
  /** Absolute path on the execution host, converted from the server's URI. */
  path: string
  version?: number
  diagnostics: LspPublishDiagnosticsParams['diagnostics']
}

export type ServerRequestHandlerContext = {
  documentPaths?: () => string[]
  label: string
  onLog?: (line: string) => void
  onDiagnostics?: (publication: ServerDiagnosticsPublication) => void
}

export function installServerRequestHandlers(
  connection: LspConnection,
  context: ServerRequestHandlerContext
): void {
  // An empty settings object per item is a valid answer and keeps servers that
  // block on configuration (gopls, pyright) from waiting forever.
  connection.onRequest('workspace/configuration', (params) => {
    const items = (params as { items?: unknown[] } | undefined)?.items ?? []
    return items.map(() => ({}))
  })
  connection.onRequest('client/registerCapability', () => null)
  connection.onRequest('client/unregisterCapability', () => null)
  connection.onRequest('window/workDoneProgress/create', () => null)
  // Orca applies edits itself, from a request it made; an unsolicited edit is
  // declined rather than silently dropped, so the server can report it.
  connection.onRequest('workspace/applyEdit', () => ({ applied: false }))
  connection.onRequest('window/showMessageRequest', () => null)

  connection.onNotification('window/logMessage', (params) => {
    const message = (params as { message?: string } | undefined)?.message
    if (message !== undefined) {
      context.onLog?.(`[${context.label}] ${message}`)
    }
  })
  connection.onNotification('window/showMessage', (params) => {
    const message = (params as { message?: string } | undefined)?.message
    if (message !== undefined) {
      context.onLog?.(`[${context.label}] ${message}`)
    }
  })
  connection.onNotification('textDocument/publishDiagnostics', (params) => {
    const published = params as LspPublishDiagnosticsParams | undefined
    if (typeof published?.uri !== 'string') {
      return
    }
    let path: string
    try {
      path = fileURLToPath(published.uri)
    } catch {
      // Servers publish for non-file URIs too (a generated or virtual module).
      // Orca has no surface for those, so they are dropped, not guessed at.
      return
    }
    context.onDiagnostics?.({
      // Servers may lowercase Windows drive letters; keep the editor's spelling.
      path:
        context
          .documentPaths?.()
          .find(
            (openPath) =>
              normalizeRuntimePathForComparison(openPath) ===
              normalizeRuntimePathForComparison(path)
          ) ?? path,
      version: published.version,
      diagnostics: Array.isArray(published.diagnostics) ? published.diagnostics : []
    })
  })
}
