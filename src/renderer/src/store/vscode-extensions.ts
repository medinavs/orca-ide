/**
 * Installed VS Code-compatible extensions, mirrored for the renderer.
 *
 * A store of its own, like `plugin-panels.ts`: the extensions list changes only
 * on install/remove, so folding it into the app store would wake unrelated
 * selectors for an event that happens a few times per session.
 *
 * Registering contributions into Monaco is a side effect of loading, and it is
 * done here rather than in a component so it happens exactly once regardless
 * of which surface asks first.
 */
import { create } from 'zustand'
import type {
  InstalledVscodeExtension,
  VscodeContributionBundle
} from '../../../shared/vscode-compat/vscode-extension-types'
import type { ExtensionRegistrationSummary } from '@/lib/vscode-extensions/register-extension-contributions'

export type VscodeExtensionsFetchStatus = 'idle' | 'loading' | 'ready' | 'error'

type VscodeExtensionsState = {
  extensions: InstalledVscodeExtension[]
  status: VscodeExtensionsFetchStatus
  /** Counts from the last registration, for the settings pane. */
  registration: ExtensionRegistrationSummary | null
  /** Monaco theme ids that are defined and safe to pass to `setTheme`. */
  registeredThemeIds: string[]
  error: string | null
  refresh: () => Promise<void>
  installFromVsix: () => Promise<{ ok: boolean; error?: string; canceled?: boolean }>
  installFromDirectory: () => Promise<{ ok: boolean; error?: string; canceled?: boolean }>
  remove: (extensionId: string) => Promise<boolean>
}

async function applyContributions(
  bundle: VscodeContributionBundle
): Promise<{ summary: ExtensionRegistrationSummary; themeIds: string[] }> {
  // Imported lazily so a window that never opens the editor does not pull in
  // Monaco for the sake of the extensions list.
  const [{ monaco }, { registerVscodeContributions, registeredExtensionThemeIds }] =
    await Promise.all([
      import('@/lib/monaco-setup'),
      import('@/lib/vscode-extensions/register-extension-contributions')
    ])
  const summary = registerVscodeContributions(monaco, bundle)
  return { summary, themeIds: registeredExtensionThemeIds() }
}

export const useVscodeExtensionsStore = create<VscodeExtensionsState>()((set) => ({
  extensions: [],
  status: 'idle',
  registration: null,
  registeredThemeIds: [],
  error: null,

  refresh: async () => {
    const api = window.api?.vscodeExtensions
    if (!api) {
      // An older paired desktop build or the web client: no extensions rather
      // than a broken settings pane.
      set({ status: 'ready', extensions: [] })
      return
    }
    set({ status: 'loading', error: null })
    try {
      const extensions = await api.list()
      const bundle = await api.contributions()
      // Registration is additive, so a newly installed extension is applied on
      // the next refresh too; already-defined themes and languages are skipped.
      const applied = await applyContributions(bundle)
      set({
        extensions,
        status: 'ready',
        registration: applied.summary,
        registeredThemeIds: applied.themeIds
      })
    } catch (error) {
      set({ status: 'error', error: String(error) })
    }
  },

  installFromVsix: async () => {
    const api = window.api?.vscodeExtensions
    if (!api) {
      return { ok: false, error: 'Extension installation is unavailable in this window.' }
    }
    const result = await api.installFromVsix()
    if (result.ok) {
      await useVscodeExtensionsStore.getState().refresh()
    }
    return result
  },

  installFromDirectory: async () => {
    const api = window.api?.vscodeExtensions
    if (!api) {
      return { ok: false, error: 'Extension installation is unavailable in this window.' }
    }
    const result = await api.installFromDirectory()
    if (result.ok) {
      await useVscodeExtensionsStore.getState().refresh()
    }
    return result
  },

  remove: async (extensionId) => {
    const api = window.api?.vscodeExtensions
    if (!api) {
      return false
    }
    const { removed } = await api.remove({ extensionId })
    if (removed) {
      await useVscodeExtensionsStore.getState().refresh()
    }
    return removed
  }
}))

let changeSubscriptionStarted = false
let initialLoadStarted = false

/**
 * Loads and registers installed extensions once per renderer.
 *
 * Called from the editor, not only the settings page: otherwise a user's
 * installed theme and grammars would never register until they happened to
 * open Settings → Extensions.
 */
export function ensureVscodeExtensionsLoaded(): void {
  if (initialLoadStarted || !window.api?.vscodeExtensions) {
    return
  }
  initialLoadStarted = true
  startVscodeExtensionsSubscription()
  void useVscodeExtensionsStore.getState().refresh()
}

/** Keeps the list current when another window installs or removes one. */
export function startVscodeExtensionsSubscription(): void {
  if (changeSubscriptionStarted || !window.api?.vscodeExtensions?.onChanged) {
    return
  }
  changeSubscriptionStarted = true
  window.api.vscodeExtensions.onChanged(() => {
    void useVscodeExtensionsStore.getState().refresh()
  })
}

export function resetVscodeExtensionsStoreForTests(): void {
  changeSubscriptionStarted = false
  initialLoadStarted = false
  useVscodeExtensionsStore.setState({
    extensions: [],
    status: 'idle',
    registration: null,
    registeredThemeIds: [],
    error: null
  })
}

/** Themes from installed extensions, for the appearance picker. */
export function selectExtensionThemes(
  state: VscodeExtensionsState
): { id: string; label: string; type: string; extensionId: string }[] {
  return state.extensions
    .filter((extension) => extension.enabled)
    .flatMap((extension) =>
      extension.themes.map((theme) => ({ ...theme, extensionId: extension.extensionId }))
    )
}
