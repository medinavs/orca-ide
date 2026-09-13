/**
 * Language-server status shapes shared by main, preload and the renderer.
 *
 * Lives in `shared` because the renderer and preload read these over IPC and
 * must not import from `src/main`, which the web typecheck project excludes.
 */
import type { ExecutionHostId } from '../execution-host'
import type { LspServerCapabilities } from './lsp-protocol-types'

export type LanguageServerState =
  | 'starting'
  | 'running'
  /** The program is not on the execution host's PATH; `installHint` applies. */
  | 'not-installed'
  | 'failed'
  | 'stopped'

export type LanguageServerStatus = {
  serverId: string
  label: string
  rootPath: string
  state: LanguageServerState
  capabilities?: LspServerCapabilities
  serverInfo?: { name: string; version?: string }
  /** Why it is not running, already phrased for a user. */
  message?: string
  installHint?: string
  documentationUrl?: string
  stderrTail?: string
  restarts: number
}

export type LanguageServerUnavailable = {
  state: 'unsupported-host' | 'no-server'
  message: string
  executionHostId: ExecutionHostId
  rootPath: string
}
