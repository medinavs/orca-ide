/**
 * The single source of truth for LSP diagnostics, per workspace root.
 *
 * Every reader — Monaco markers, the Problems panel, explorer badges, the
 * summary chip — subscribes to snapshots from here rather than keeping its own
 * copy, so the four surfaces cannot disagree about a file.
 *
 * The structure is root → file → server, and the nesting by server is the
 * load-bearing part. `publishDiagnostics` is a *replace* for one (server, file)
 * pair, and a server publishes an empty array to mean "this file is clean now".
 * Keying only by file would make gopls's clean publication wipe eslint's
 * findings for the same file; keying only by server would never clear a file.
 *
 * Staleness has exactly four causes and all four are handled here rather than
 * in each reader: a replacing publication, a closed document, a stopped or
 * restarted server, and a closed workspace.
 */
import {
  toWorkspaceRelativePath,
  type FileDiagnostics,
  type PublishedDiagnostic,
  type WorkspaceDiagnosticsSnapshot
} from '../../shared/lsp/workspace-diagnostics'
import type { LspDiagnostic } from '../../shared/lsp/lsp-protocol-types'

export type DiagnosticsPublication = {
  rootPath: string
  serverId: string
  /** Absolute path on the execution host. */
  path: string
  diagnostics: readonly LspDiagnostic[]
}

export type DiagnosticsStoreOptions = {
  /** True when the execution host's filesystem is case-insensitive. */
  caseInsensitivePaths?: boolean
  /**
   * A server that floods (a misconfigured linter on a generated file) must not
   * grow main's heap without bound. Extra diagnostics past the cap are dropped
   * and the count is reported so the UI can say so.
   */
  maxDiagnosticsPerFile?: number
}

export const DEFAULT_MAX_DIAGNOSTICS_PER_FILE = 1_000

export type DiagnosticsStore = {
  /** Replaces one server's diagnostics for one file. Returns true if changed. */
  publish(publication: DiagnosticsPublication): boolean
  /** Clears every server's diagnostics for one file (document closed). */
  clearFile(rootPath: string, path: string): boolean
  /** Clears one server everywhere in a root (server stopped or restarting). */
  clearServer(rootPath: string, serverId: string): boolean
  /** Clears a whole workspace (workspace closed). */
  clearWorkspace(rootPath: string): boolean
  snapshot(rootPath: string): WorkspaceDiagnosticsSnapshot
  /** Every root that currently holds at least one diagnostic. */
  roots(): string[]
  subscribe(listener: (snapshot: WorkspaceDiagnosticsSnapshot) => void): () => void
}

type ByServer = Map<string, PublishedDiagnostic[]>
type ByFile = Map<string, ByServer>

export function createDiagnosticsStore(
  options: DiagnosticsStoreOptions = {}
): DiagnosticsStore {
  const roots = new Map<string, ByFile>()
  const listeners = new Set<(snapshot: WorkspaceDiagnosticsSnapshot) => void>()
  const maxPerFile = options.maxDiagnosticsPerFile ?? DEFAULT_MAX_DIAGNOSTICS_PER_FILE

  function snapshot(rootPath: string): WorkspaceDiagnosticsSnapshot {
    const byFile = roots.get(rootPath)
    const files: FileDiagnostics[] = []
    for (const [path, byServer] of byFile ?? []) {
      const diagnostics = [...byServer.values()].flat()
      if (diagnostics.length === 0) {
        continue
      }
      files.push({
        path,
        relativePath: toWorkspaceRelativePath(rootPath, path, {
          caseInsensitive: options.caseInsensitivePaths
        }),
        diagnostics
      })
    }
    return { rootPath, files }
  }

  function notify(rootPath: string): void {
    if (listeners.size === 0) {
      return
    }
    const published = snapshot(rootPath)
    for (const listener of listeners) {
      listener(published)
    }
  }

  /** Drops empty maps so `roots()` and snapshots never report clean files. */
  function prune(rootPath: string, byFile: ByFile, path?: string): void {
    if (path !== undefined) {
      const byServer = byFile.get(path)
      if (byServer && [...byServer.values()].every((list) => list.length === 0)) {
        byFile.delete(path)
      }
    }
    if (byFile.size === 0) {
      roots.delete(rootPath)
    }
  }

  function sameDiagnostics(
    previous: PublishedDiagnostic[] | undefined,
    next: PublishedDiagnostic[]
  ): boolean {
    if (previous === undefined) {
      return next.length === 0
    }
    if (previous.length !== next.length) {
      return false
    }
    // Structural compare: servers republish identical sets on every keystroke,
    // and re-rendering four surfaces for an unchanged set is pure waste.
    return previous.every((diagnostic, index) => {
      const candidate = next[index]!
      return (
        diagnostic.message === candidate.message &&
        diagnostic.severity === candidate.severity &&
        diagnostic.code === candidate.code &&
        diagnostic.range.start.line === candidate.range.start.line &&
        diagnostic.range.start.character === candidate.range.start.character &&
        diagnostic.range.end.line === candidate.range.end.line &&
        diagnostic.range.end.character === candidate.range.end.character
      )
    })
  }

  return {
    publish({ rootPath, serverId, path, diagnostics }) {
      const tagged: PublishedDiagnostic[] = diagnostics
        .slice(0, maxPerFile)
        .map((diagnostic) => ({ ...diagnostic, serverId }))
      const byFile = roots.get(rootPath)
      const existing = byFile?.get(path)?.get(serverId)
      if (sameDiagnostics(existing, tagged)) {
        return false
      }
      if (tagged.length === 0) {
        // "Clean now" for this server only; other servers keep their findings.
        byFile?.get(path)?.delete(serverId)
        if (byFile) {
          prune(rootPath, byFile, path)
        }
        notify(rootPath)
        return true
      }
      const resolvedByFile = byFile ?? new Map<string, ByServer>()
      roots.set(rootPath, resolvedByFile)
      const byServer = resolvedByFile.get(path) ?? new Map<string, PublishedDiagnostic[]>()
      resolvedByFile.set(path, byServer)
      byServer.set(serverId, tagged)
      notify(rootPath)
      return true
    },

    clearFile(rootPath, path) {
      const byFile = roots.get(rootPath)
      if (!byFile?.delete(path)) {
        return false
      }
      prune(rootPath, byFile)
      notify(rootPath)
      return true
    },

    clearServer(rootPath, serverId) {
      const byFile = roots.get(rootPath)
      if (!byFile) {
        return false
      }
      let changed = false
      // Collected first, deleted after: removing entries while iterating the
      // same map is the kind of thing that silently skips a file.
      const emptied: string[] = []
      for (const [path, byServer] of byFile) {
        if (byServer.delete(serverId)) {
          changed = true
        }
        if (byServer.size === 0) {
          emptied.push(path)
        }
      }
      for (const path of emptied) {
        byFile.delete(path)
      }
      if (!changed) {
        return false
      }
      prune(rootPath, byFile)
      notify(rootPath)
      return true
    },

    clearWorkspace(rootPath) {
      if (!roots.delete(rootPath)) {
        return false
      }
      notify(rootPath)
      return true
    },

    snapshot,
    roots: () => [...roots.keys()],

    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
