import React, { useCallback, useMemo } from 'react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { useActiveWorktree } from '@/store/selectors'
import { startLspDiagnosticsSubscription, useLspDiagnosticsStore } from '@/store/lsp-diagnostics'
import { emptyDiagnosticCounts } from '../../../../shared/lsp/diagnostic-severity'
import { snapshotDiagnosticCounts } from '../../../../shared/lsp/workspace-diagnostics'
import { DIAGNOSTIC_SEVERITY_PRESENTATION } from './diagnostic-severity-presentation'

/**
 * `✕ 2  ⚠ 3` for the active workspace; clicking opens the Problems panel.
 *
 * Renders nothing when the workspace is clean — a persistent `0 0` is noise,
 * and its absence is the same information.
 */
export function DiagnosticsSummaryChip({
  className
}: {
  className?: string
}): React.JSX.Element | null {
  const rootPath = useActiveWorktree()?.path ?? null
  // Why select the snapshot, not the counts: a selector returning a fresh
  // object on every call makes zustand's useSyncExternalStore report a change
  // on every render — React #185. The snapshot reference is stable until main
  // publishes, so counts are derived from it instead.
  const snapshot = useLspDiagnosticsStore((state) =>
    rootPath === null ? undefined : state.byRoot[rootPath]
  )
  const counts = useMemo(
    () => (snapshot === undefined ? emptyDiagnosticCounts() : snapshotDiagnosticCounts(snapshot)),
    [snapshot]
  )
  const setRightSidebarTab = useAppStore((s) => s.setRightSidebarTab)
  const setRightSidebarOpen = useAppStore((s) => s.setRightSidebarOpen)

  React.useEffect(() => {
    startLspDiagnosticsSubscription()
  }, [])

  const openProblems = useCallback(() => {
    setRightSidebarOpen(true)
    setRightSidebarTab('problems')
  }, [setRightSidebarOpen, setRightSidebarTab])

  if (counts.error === 0 && counts.warning === 0) {
    return null
  }

  const label = translate('auto.components.diagnostics.summaryChip', 'Open Problems')
  return (
    <button
      type="button"
      onClick={openProblems}
      title={label}
      aria-label={`${label}: ${counts.error} errors, ${counts.warning} warnings`}
      className={`flex items-center gap-2 rounded px-1.5 py-0.5 text-xs tabular-nums hover:bg-accent hover:text-accent-foreground ${className ?? ''}`}
    >
      {(['error', 'warning'] as const).map((severity) => {
        const presentation = DIAGNOSTIC_SEVERITY_PRESENTATION[severity]
        const Icon = presentation.icon
        return (
          <span key={severity} className="flex items-center gap-1">
            <Icon className={`size-3 ${presentation.textClass}`} aria-hidden />
            {counts[severity]}
          </span>
        )
      })}
    </button>
  )
}
