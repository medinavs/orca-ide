import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useActiveWorktree } from '@/store/selectors'
import { translate } from '@/i18n/i18n'
import { startLspDiagnosticsSubscription, useLspDiagnosticsStore } from '@/store/lsp-diagnostics'
import {
  buildProblemsPanelModel,
  type ProblemsPanelFileGroup
} from '../diagnostics/problems-panel-model'
import {
  DIAGNOSTIC_SEVERITY_PRESENTATION,
  formatDiagnosticPosition
} from '../diagnostics/diagnostic-severity-presentation'
import {
  cancelDiagnosticRevealFrames,
  openDiagnosticLocation
} from '../diagnostics/diagnostic-navigation'
import { LanguageServerStatusNotice } from '../diagnostics/LanguageServerStatusNotice'

export default function ProblemsPanel(): React.JSX.Element {
  const activeWorktree = useActiveWorktree()
  const rootPath = activeWorktree?.path ?? null
  const worktreeId = activeWorktree?.id ?? null
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, true>>({})
  const outerFrame = useRef<number | null>(null)
  const innerFrame = useRef<number | null>(null)

  // Why raw store references: selecting a derived object or a `.filter()` array
  // returns a new value on every call, which zustand's useSyncExternalStore
  // reads as a change on every render — React #185. Derive in useMemo instead.
  const storedSnapshot = useLspDiagnosticsStore((state) =>
    rootPath === null ? undefined : state.byRoot[rootPath]
  )
  const serverStatuses = useLspDiagnosticsStore((state) => state.serverStatuses)
  const snapshot = useMemo(
    () => storedSnapshot ?? { rootPath: rootPath ?? '', files: [] },
    [storedSnapshot, rootPath]
  )
  const statuses = useMemo(
    () =>
      rootPath === null
        ? []
        : Object.values(serverStatuses).filter((status) => status.rootPath === rootPath),
    [serverStatuses, rootPath]
  )
  const loadWorkspace = useLspDiagnosticsStore((state) => state.loadWorkspace)

  useEffect(() => {
    startLspDiagnosticsSubscription()
    if (rootPath !== null) {
      void loadWorkspace(rootPath)
    }
  }, [loadWorkspace, rootPath])

  // Why: the reveal is scheduled across two animation frames, so an unmount
  // mid-navigation must cancel them or the callback runs against a dead panel.
  useEffect(() => () => cancelDiagnosticRevealFrames({ outer: outerFrame, inner: innerFrame }), [])

  const model = useMemo(() => buildProblemsPanelModel(snapshot, { query }), [snapshot, query])

  const navigate = useCallback(
    (group: ProblemsPanelFileGroup, line: number, column: number) => {
      if (worktreeId === null) {
        return
      }
      openDiagnosticLocation(
        {
          worktreeId,
          filePath: group.path,
          relativePath: group.relativePath,
          line,
          column
        },
        { outer: outerFrame, inner: innerFrame }
      )
    },
    [worktreeId]
  )

  const toggle = useCallback((path: string) => {
    setCollapsed((current) => {
      if (current[path]) {
        const next = { ...current }
        delete next[path]
        return next
      }
      return { ...current, [path]: true }
    })
  }, [])

  if (rootPath === null) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
        {translate(
          'auto.components.right.sidebar.problems.noWorkspace',
          'Open a workspace to see problems.'
        )}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={translate(
            'auto.components.right.sidebar.problems.filterPlaceholder',
            'Filter problems'
          )}
          className="h-6 min-w-0 flex-1 rounded border border-border bg-input px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label={translate(
            'auto.components.right.sidebar.problems.filterPlaceholder',
            'Filter problems'
          )}
        />
        <ProblemsCountSummary counts={model.counts} />
      </div>

      <LanguageServerStatusNotice statuses={statuses} />

      <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto">
        {model.total === 0 ? (
          <div className="p-4 text-center text-xs text-muted-foreground">
            {snapshot.files.length === 0
              ? translate(
                  'auto.components.right.sidebar.problems.empty',
                  'No problems have been detected in this workspace.'
                )
              : translate(
                  'auto.components.right.sidebar.problems.noMatches',
                  'No problems match the filter.'
                )}
          </div>
        ) : (
          model.groups.map((group) => (
            <ProblemsFileGroup
              key={group.path}
              group={group}
              collapsed={collapsed[group.path] === true}
              onToggle={toggle}
              onNavigate={navigate}
            />
          ))
        )}
      </div>
    </div>
  )
}

function ProblemsCountSummary({
  counts
}: {
  counts: ReturnType<typeof buildProblemsPanelModel>['counts']
}): React.JSX.Element {
  return (
    <div className="flex shrink-0 items-center gap-2 text-xs tabular-nums">
      {(['error', 'warning'] as const).map((severity) => {
        const presentation = DIAGNOSTIC_SEVERITY_PRESENTATION[severity]
        const Icon = presentation.icon
        return (
          <span
            key={severity}
            className="flex items-center gap-1 text-muted-foreground"
            title={translate(
              `auto.components.right.sidebar.problems.count.${severity}`,
              presentation.label
            )}
          >
            <Icon className={`size-3 ${presentation.textClass}`} aria-hidden />
            {counts[severity]}
          </span>
        )
      })}
    </div>
  )
}

function ProblemsFileGroup({
  group,
  collapsed,
  onToggle,
  onNavigate
}: {
  group: ProblemsPanelFileGroup
  collapsed: boolean
  onToggle: (path: string) => void
  onNavigate: (group: ProblemsPanelFileGroup, line: number, column: number) => void
}): React.JSX.Element {
  const Chevron = collapsed ? ChevronRight : ChevronDown
  return (
    <div>
      <button
        type="button"
        onClick={() => onToggle(group.path)}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-1 px-2 py-1 text-left text-xs hover:bg-accent hover:text-accent-foreground"
      >
        <Chevron className="size-3 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate font-medium">{group.fileName}</span>
        {group.directory !== '' && (
          <span className="truncate text-muted-foreground">{group.directory}</span>
        )}
        <span className="ml-auto shrink-0 rounded bg-muted px-1 text-[10px] tabular-nums text-muted-foreground">
          {group.rows.length}
        </span>
      </button>
      {!collapsed &&
        group.rows.map((row) => {
          const presentation = DIAGNOSTIC_SEVERITY_PRESENTATION[row.severity]
          const Icon = presentation.icon
          return (
            <button
              key={row.key}
              type="button"
              onClick={() => onNavigate(group, row.line, row.column)}
              className="flex w-full items-start gap-1.5 py-1 pl-6 pr-2 text-left text-xs hover:bg-accent hover:text-accent-foreground"
            >
              <Icon
                className={`mt-0.5 size-3 shrink-0 ${presentation.textClass}`}
                aria-label={presentation.label}
              />
              <span className="min-w-0 flex-1 break-words">{row.message}</span>
              <span className="shrink-0 text-muted-foreground">
                {row.source}
                {row.code === undefined ? '' : `(${row.code})`}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {formatDiagnosticPosition(row.line, row.column)}
              </span>
            </button>
          )
        })}
    </div>
  )
}
