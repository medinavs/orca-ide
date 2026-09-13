/**
 * The Monaco theme every editor surface should use.
 *
 * One hook for all of them because Monaco's theme is global: `setTheme` from
 * any editor restyles every editor. If the file editor applied the user's
 * extension theme while a diff viewer still passed `vs-dark`, whichever mounted
 * last would win and the theme would flicker between the two.
 *
 * Falls back to the built-in light/dark theme until the chosen theme is
 * actually registered — `setTheme` with an undefined id silently keeps the old
 * theme, so asking for it early would look like selection had no effect.
 */
import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { ensureVscodeExtensionsLoaded, useVscodeExtensionsStore } from '@/store/vscode-extensions'

export function useMonacoThemeId(isDark: boolean): string {
  const selected = useAppStore((state) => state.settings?.vscodeColorThemeId)
  // A stable array reference from the store; `.includes` runs outside the
  // selector so the hook never returns a fresh value per render (React #185).
  const registered = useVscodeExtensionsStore((state) => state.registeredThemeIds)

  useEffect(() => {
    ensureVscodeExtensionsLoaded()
  }, [])

  if (selected !== undefined && selected !== '' && registered.includes(selected)) {
    return selected
  }
  return isDark ? 'vs-dark' : 'vs'
}
