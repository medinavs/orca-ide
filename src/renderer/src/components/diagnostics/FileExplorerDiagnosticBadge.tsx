import React from 'react'
import { translate } from '@/i18n/i18n'
import { useActiveWorktree } from '@/store/selectors'
import { useLspDiagnosticsStore } from '@/store/lsp-diagnostics'
import {
  buildDiagnosticTreeBadges,
  type WorkspaceDiagnosticsSnapshot
} from '../../../../shared/lsp/workspace-diagnostics'
import type { DiagnosticSeverityName } from '../../../../shared/lsp/diagnostic-severity'
import { DIAGNOSTIC_SEVERITY_PRESENTATION } from './diagnostic-severity-presentation'

/**
 * Worst-severity dot for one explorer row.
 *
 * A dot, not a glyph: explorer rows are dense and already carry a git status
 * badge, an ignored marker and a file-type icon. Severity is carried by color
 * from the theme tokens, and the accessible name states it in words so the
 * meaning does not depend on color alone.
 *
 * The component reads the store itself instead of taking a prop because the
 * explorer's rows are virtualized — threading a badge map through the list
 * would re-render every visible row whenever any file's diagnostics changed.
 */

const badgeCache = new WeakMap<
  WorkspaceDiagnosticsSnapshot,
  ReturnType<typeof buildDiagnosticTreeBadges>
>()

/** Memoized per snapshot: every visible row would otherwise rebuild the map. */
function badgesFor(snapshot: WorkspaceDiagnosticsSnapshot): ReturnType<
  typeof buildDiagnosticTreeBadges
> {
  const cached = badgeCache.get(snapshot)
  if (cached) {
    return cached
  }
  const built = buildDiagnosticTreeBadges(snapshot)
  badgeCache.set(snapshot, built)
  return built
}

export function useDiagnosticBadgeSeverity(
  rootPath: string | null,
  relativePath: string,
  isDirectory: boolean
): DiagnosticSeverityName | null {
  return useLspDiagnosticsStore((state) => {
    if (rootPath === null) {
      return null
    }
    const snapshot = state.byRoot[rootPath]
    if (snapshot === undefined) {
      return null
    }
    const badges = badgesFor(snapshot)
    const key = relativePath.replace(/\\/g, '/').replace(/\/+$/, '')
    return (isDirectory ? badges.directories.get(key) : badges.files.get(key)) ?? null
  })
}

export function FileExplorerDiagnosticBadge({
  relativePath,
  isDirectory
}: {
  relativePath: string
  isDirectory: boolean
}): React.JSX.Element | null {
  // Resolved here rather than threaded as a prop: the explorer's rows are
  // virtualized through several layers, and the active workspace is already a
  // memoized selector, so reading it here costs less than the prop drilling.
  const rootPath = useActiveWorktree()?.path ?? null
  const severity = useDiagnosticBadgeSeverity(rootPath, relativePath, isDirectory)
  if (severity === null) {
    return null
  }
  const presentation = DIAGNOSTIC_SEVERITY_PRESENTATION[severity]
  return (
    <span
      aria-label={translate(
        `auto.components.diagnostics.badge.${severity}`,
        presentation.label
      )}
      title={translate(`auto.components.diagnostics.badge.${severity}`, presentation.label)}
      className={`ml-1 size-1.5 shrink-0 rounded-full ${presentation.dotClass}`}
    />
  )
}
