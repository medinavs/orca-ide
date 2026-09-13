/**
 * Renderer-side mirror of the main-process diagnostics store.
 *
 * A store of its own rather than a slice of the app store: diagnostics change
 * on every keystroke a server reacts to, and folding that traffic into the
 * shared store would wake every unrelated selector. Readers here are the
 * editor markers, the Problems panel, the explorer badges and the summary chip.
 *
 * Main is authoritative. This never derives a diagnostic, only presents one.
 */
import { create } from 'zustand'
import type { LanguageServerStatus } from '../../../main/lsp/language-server-session'
import {
  buildDiagnosticTreeBadges,
  snapshotDiagnosticCounts,
  type DiagnosticTreeBadges,
  type WorkspaceDiagnosticsSnapshot
} from '../../../shared/lsp/workspace-diagnostics'
import {
  emptyDiagnosticCounts,
  type DiagnosticCounts
} from '../../../shared/lsp/diagnostic-severity'

const EMPTY_SNAPSHOT: WorkspaceDiagnosticsSnapshot = { rootPath: '', files: [] }

type LspDiagnosticsState = {
  /** Keyed by workspace root path, as main publishes them. */
  byRoot: Record<string, WorkspaceDiagnosticsSnapshot>
  /** Latest status per `${rootPath}|${serverId}`. */
  serverStatuses: Record<string, LanguageServerStatus>
  applySnapshot: (snapshot: WorkspaceDiagnosticsSnapshot) => void
  applyStatus: (status: LanguageServerStatus) => void
  /** Drops a workspace's mirror when its tab or window goes away. */
  forgetWorkspace: (rootPath: string) => void
  loadWorkspace: (rootPath: string) => Promise<void>
}

export const useLspDiagnosticsStore = create<LspDiagnosticsState>()((set) => ({
  byRoot: {},
  serverStatuses: {},

  applySnapshot: (snapshot) =>
    set((state) => {
      if (snapshot.files.length === 0 && state.byRoot[snapshot.rootPath] === undefined) {
        // Nothing to mirror and nothing mirrored: skip the write so readers
        // are not woken by a clean workspace reporting that it is still clean.
        return state
      }
      return { byRoot: { ...state.byRoot, [snapshot.rootPath]: snapshot } }
    }),

  applyStatus: (status) =>
    set((state) => ({
      serverStatuses: {
        ...state.serverStatuses,
        [`${status.rootPath}|${status.serverId}`]: status
      }
    })),

  forgetWorkspace: (rootPath) =>
    set((state) => {
      if (state.byRoot[rootPath] === undefined) {
        return state
      }
      const byRoot = { ...state.byRoot }
      delete byRoot[rootPath]
      return { byRoot }
    }),

  loadWorkspace: async (rootPath) => {
    // Fail-soft on a preload without the namespace (an older paired desktop
    // build, or the web client): no diagnostics rather than a broken editor.
    const api = window.api?.languageServers
    if (!api) {
      return
    }
    try {
      const snapshot = await api.diagnostics(rootPath)
      set((state) => ({ byRoot: { ...state.byRoot, [snapshot.rootPath]: snapshot } }))
    } catch {
      /* main not ready yet; the push subscription will deliver the next change */
    }
  }
}))

let subscriptionStarted = false

/**
 * Binds the push subscriptions once per renderer.
 *
 * Idempotent because several surfaces may mount before any of them knows
 * whether another already started it, and a second subscription would double
 * every marker update.
 */
export function startLspDiagnosticsSubscription(): void {
  if (subscriptionStarted) {
    return
  }
  const api = window.api?.languageServers
  if (!api) {
    return
  }
  subscriptionStarted = true
  api.onDiagnosticsChanged((snapshot) => {
    useLspDiagnosticsStore.getState().applySnapshot(snapshot)
  })
  api.onStatusChanged((status) => {
    useLspDiagnosticsStore.getState().applyStatus(status)
  })
}

/** Test seam: lets a suite re-bind the subscription against a fresh stub. */
export function resetLspDiagnosticsSubscriptionForTests(): void {
  subscriptionStarted = false
  useLspDiagnosticsStore.setState({ byRoot: {}, serverStatuses: {} })
}

export function selectWorkspaceDiagnostics(
  state: LspDiagnosticsState,
  rootPath: string | null | undefined
): WorkspaceDiagnosticsSnapshot {
  if (!rootPath) {
    return EMPTY_SNAPSHOT
  }
  return state.byRoot[rootPath] ?? { rootPath, files: [] }
}

export function selectFileDiagnostics(
  state: LspDiagnosticsState,
  rootPath: string | null | undefined,
  path: string
): WorkspaceDiagnosticsSnapshot['files'][number] | null {
  return selectWorkspaceDiagnostics(state, rootPath).files.find((file) => file.path === path) ?? null
}

export function selectWorkspaceCounts(
  state: LspDiagnosticsState,
  rootPath: string | null | undefined
): DiagnosticCounts {
  if (!rootPath || state.byRoot[rootPath] === undefined) {
    return emptyDiagnosticCounts()
  }
  return snapshotDiagnosticCounts(state.byRoot[rootPath]!)
}

export function selectTreeBadges(
  state: LspDiagnosticsState,
  rootPath: string | null | undefined
): DiagnosticTreeBadges {
  return buildDiagnosticTreeBadges(selectWorkspaceDiagnostics(state, rootPath))
}

export function selectServerStatuses(
  state: LspDiagnosticsState,
  rootPath: string | null | undefined
): LanguageServerStatus[] {
  if (!rootPath) {
    return []
  }
  return Object.values(state.serverStatuses).filter((status) => status.rootPath === rootPath)
}
