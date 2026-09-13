// @vitest-environment happy-dom

/**
 * Regression for React #185 ("Maximum update depth exceeded") on startup.
 *
 * Zustand 5 hooks run on useSyncExternalStore, which treats a selector that
 * returns a new object on every call as a store that changed on every render —
 * an infinite loop. The status-bar chip and the Problems panel both did that
 * for a workspace with no diagnostics yet, which is every workspace at launch,
 * and the packaged app crashed both surfaces within a second of starting.
 *
 * These render the real components against the real store, because the bug is
 * invisible to a pure selector test: it only exists inside React.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetLspDiagnosticsSubscriptionForTests,
  useLspDiagnosticsStore
} from '@/store/lsp-diagnostics'

const ROOT = '/repo'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/store/selectors', () => ({
  useActiveWorktree: () => ({ id: 'repo::/repo', path: ROOT })
}))
vi.mock('@/store', () => {
  const state = {
    setRightSidebarTab: () => {},
    setRightSidebarOpen: () => {},
    settingsSearchQuery: '',
    settings: { vscodeColorThemeId: 'vscode-demo' }
  }
  return {
    useAppStore: (selector: (s: typeof state) => unknown) => selector(state)
  }
})
vi.mock('../diagnostics/diagnostic-navigation', () => ({
  openDiagnosticLocation: vi.fn(),
  cancelDiagnosticRevealFrames: vi.fn()
}))

import { renderHook } from '@testing-library/react'
import { DiagnosticsSummaryChip } from './DiagnosticsSummaryChip'
import { VscodeExtensionsSettingsSection } from '../settings/VscodeExtensionsSettingsSection'
import { ActiveSettingsSectionProvider } from '../settings/SettingsSection'
import { useMonacoThemeId } from '@/lib/vscode-extensions/use-monaco-theme-id'
import {
  resetVscodeExtensionsStoreForTests,
  useVscodeExtensionsStore
} from '@/store/vscode-extensions'
import ProblemsPanel from '../right-sidebar/ProblemsPanel'

beforeEach(() => {
  ;(globalThis as { window: { api?: unknown } }).window.api = {
    vscodeExtensions: {
      list: async () => [],
      contributions: async () => ({
        themes: [],
        languages: [],
        grammars: [],
        snippets: [],
        commands: [],
        configurationDefaults: {}
      }),
      onChanged: () => () => {}
    },
    languageServers: {
      diagnostics: async (rootPath: string) => ({ rootPath, files: [] }),
      onDiagnosticsChanged: () => () => {},
      onStatusChanged: () => () => {}
    }
  }
  resetLspDiagnosticsSubscriptionForTests()
  resetVscodeExtensionsStoreForTests()
})

afterEach(cleanup)

function publishError(): void {
  useLspDiagnosticsStore.getState().applySnapshot({
    rootPath: ROOT,
    files: [
      {
        path: `${ROOT}/main.go`,
        relativePath: 'main.go',
        diagnostics: [
          {
            serverId: 'gopls',
            message: 'undefined: foo',
            severity: 1,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }
          }
        ]
      }
    ]
  })
}

describe('diagnostics surfaces render without an update loop', () => {
  it('renders the status-bar chip for a workspace with no diagnostics yet', () => {
    // The startup state that crashed: nothing published for this root.
    expect(() => render(<DiagnosticsSummaryChip />)).not.toThrow()
  })

  it('renders the chip once diagnostics arrive, and shows the count', () => {
    publishError()
    render(<DiagnosticsSummaryChip />)
    expect(screen.getByRole('button').textContent).toContain('1')
  })

  it('renders the Problems panel for a workspace with no diagnostics yet', () => {
    expect(() => render(<ProblemsPanel />)).not.toThrow()
    expect(screen.getByText('No problems have been detected in this workspace.')).toBeDefined()
  })

  it('renders the Problems panel with diagnostics and a server status', () => {
    publishError()
    useLspDiagnosticsStore.getState().applyStatus({
      serverId: 'gopls',
      label: 'gopls',
      rootPath: ROOT,
      state: 'running',
      restarts: 0
    })
    expect(() => render(<ProblemsPanel />)).not.toThrow()
    expect(screen.getByText('undefined: foo')).toBeDefined()
  })
})

describe('extension surfaces render without an update loop', () => {
  it('renders the Extensions settings pane', () => {
    expect(() =>
      render(
        <ActiveSettingsSectionProvider value="vscode-extensions">
          <VscodeExtensionsSettingsSection settings={{} as never} updateSettings={async () => {}} />
        </ActiveSettingsSectionProvider>
      )
    ).not.toThrow()
    expect(screen.getByText('Install VSIX')).toBeDefined()
  })

  it('falls back to the built-in theme until the chosen one is registered', () => {
    const { result, rerender } = renderHook(({ dark }) => useMonacoThemeId(dark), {
      initialProps: { dark: true }
    })
    expect(result.current).toBe('vs-dark')
    // setTheme with an unregistered id silently keeps the old theme, so the
    // hook must not hand one out early.
    useVscodeExtensionsStore.setState({ registeredThemeIds: ['vscode-demo'] })
    rerender({ dark: true })
    expect(result.current).toBe('vscode-demo')
  })
})
