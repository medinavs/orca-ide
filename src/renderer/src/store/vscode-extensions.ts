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
  error: string | null
  refresh: () => Promise<void>
  installFromVsix: () => Promise<{ ok: boolean; error?: string; canceled?: boolean }>
  installFromDirectory: () => Promise<{ ok: boolean; error?: string; canceled?: boolean }>
  remove: (extensionId: string) => Promise<boolean>
}

/** Applied once; Monaco registration is additive and cannot be undone. */
let contributionsApplied = false

async function applyContributions(
  bundle: VscodeContributionBundle
): Promise<ExtensionRegistrationSummary | null> {
  // Imported lazily so a window that never opens the editor does not pull in
  // Monaco for the sake of the extensions list.
  const [{ monaco }, { registerVscodeContributions }] = await Promise.all([
    import('@/lib/monaco-setup'),
    import('@/lib/vscode-extensions/register-extension-contributions')
  ])
  return registerVscodeContributions(monaco, bundle)
}

export const useVscodeExtensionsStore = create<VscodeExtensionsState>()((set) => ({
  extensions: [],
  status: 'idle',
  registration: null,
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
      const registration = contributionsApplied ? null : await applyContributions(bundle)
      contributionsApplied = true
      set((state) => ({
        extensions,
        status: 'ready',
        registration: registration ?? state.registration
      }))
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
  contributionsApplied = false
  changeSubscriptionStarted = false
  useVscodeExtensionsStore.setState({
    extensions: [],
    status: 'idle',
    registration: null,
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
