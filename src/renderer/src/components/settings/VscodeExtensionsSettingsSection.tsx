import React, { useEffect, useState } from 'react'
import { FileArchive, FolderOpen, Trash2, TriangleAlert } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  startVscodeExtensionsSubscription,
  useVscodeExtensionsStore
} from '@/store/vscode-extensions'
import { Button } from '../ui/button'
import { SettingsSection } from './SettingsSection'

/**
 * Install and manage VS Code-compatible extensions.
 *
 * Kept separate from the Plugins section on purpose: an Orca plugin is
 * consented and can run a worker, while these contribute only declarative data
 * (themes, grammars, snippets, language configuration). One shared list would
 * have to either over-prompt for a color theme or under-prompt for a plugin.
 */
export function VscodeExtensionsSettingsSection({
  isActive,
  settings,
  updateSettings
}: {
  isActive?: boolean
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void>
}): React.JSX.Element {
  const extensions = useVscodeExtensionsStore((state) => state.extensions)
  const status = useVscodeExtensionsStore((state) => state.status)
  const storeError = useVscodeExtensionsStore((state) => state.error)
  const refresh = useVscodeExtensionsStore((state) => state.refresh)
  const installFromVsix = useVscodeExtensionsStore((state) => state.installFromVsix)
  const installFromDirectory = useVscodeExtensionsStore((state) => state.installFromDirectory)
  const remove = useVscodeExtensionsStore((state) => state.remove)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    startVscodeExtensionsSubscription()
    void refresh()
  }, [refresh])

  const disabledIds = settings.disabledVscodeExtensionIds ?? []

  const install = async (source: 'vsix' | 'directory'): Promise<void> => {
    setBusy(true)
    setActionError(null)
    try {
      const result = source === 'vsix' ? await installFromVsix() : await installFromDirectory()
      // A cancelled picker is not an error and gets no message.
      if (!result.ok && result.canceled !== true) {
        setActionError(
          result.error ??
            translate(
              'auto.components.settings.vscodeExtensions.installFailed',
              'The extension could not be installed.'
            )
        )
      }
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (extensionId: string, enabled: boolean): Promise<void> => {
    const next = enabled
      ? disabledIds.filter((id) => id !== extensionId)
      : [...new Set([...disabledIds, extensionId])]
    await updateSettings({ disabledVscodeExtensionIds: next })
    await refresh()
  }

  return (
    <SettingsSection
      id="vscode-extensions"
      isActive={isActive}
      title={translate('auto.components.settings.vscodeExtensions.title', 'Extensions')}
      description={translate(
        'auto.components.settings.vscodeExtensions.description',
        'Install VS Code-compatible extensions for color themes, syntax highlighting, snippets and language configuration.'
      )}
      headerAction={
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void install('vsix')}>
            <FileArchive className="size-3.5" aria-hidden />
            {translate('auto.components.settings.vscodeExtensions.installVsix', 'Install VSIX')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void install('directory')}
          >
            <FolderOpen className="size-3.5" aria-hidden />
            {translate(
              'auto.components.settings.vscodeExtensions.installFolder',
              'From folder'
            )}
          </Button>
        </div>
      }
    >
      {actionError !== null && (
        <p className="text-xs text-destructive" role="alert">
          {actionError}
        </p>
      )}
      {storeError !== null && (
        <p className="text-xs text-destructive" role="alert">
          {storeError}
        </p>
      )}

      {status === 'loading' && extensions.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {translate('auto.components.settings.vscodeExtensions.loading', 'Loading…')}
        </p>
      ) : extensions.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.vscodeExtensions.empty',
            'No extensions are installed. Orca supports color themes, grammars, snippets, language configuration and command declarations — not extension code.'
          )}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {extensions.map((extension) => (
            <li
              key={extension.extensionId}
              className="rounded border border-border p-3 text-xs"
            >
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-sm">
                      {extension.displayName}
                    </span>
                    <span className="shrink-0 text-muted-foreground">{extension.version}</span>
                  </div>
                  <p className="mt-0.5 truncate text-muted-foreground">
                    {extension.extensionId}
                  </p>
                  <p className="mt-1">{extension.summary}</p>
                </div>
                <label className="flex shrink-0 items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={extension.enabled}
                    onChange={(event) =>
                      void toggle(extension.extensionId, event.target.checked)
                    }
                  />
                  {translate('auto.components.settings.vscodeExtensions.enabled', 'Enabled')}
                </label>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={translate(
                    'auto.components.settings.vscodeExtensions.remove',
                    'Remove extension'
                  )}
                  onClick={() => void remove(extension.extensionId)}
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </Button>
              </div>

              <VscodeExtensionNotices
                unsupported={extension.unsupported}
                problems={extension.problems}
              />
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  )
}

/**
 * The compatibility boundary, stated before the user wonders why something is
 * missing. Collapsed by default so a working extension reads as working.
 */
function VscodeExtensionNotices({
  unsupported,
  problems
}: {
  unsupported: { feature: string; explanation: string }[]
  problems: string[]
}): React.JSX.Element | null {
  const total = unsupported.length + problems.length
  if (total === 0) {
    return null
  }
  return (
    <details className="mt-2">
      <summary className="flex cursor-pointer items-center gap-1.5 text-diagnostic-warning">
        <TriangleAlert className="size-3.5" aria-hidden />
        {translate(
          'auto.components.settings.vscodeExtensions.notices',
          '{{count}} thing(s) Orca does not apply'
        ).replace('{{count}}', String(total))}
      </summary>
      <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-5 text-muted-foreground">
        {unsupported.map((entry) => (
          <li key={entry.feature}>{entry.explanation}</li>
        ))}
        {problems.map((problem) => (
          <li key={problem}>{problem}</li>
        ))}
      </ul>
    </details>
  )
}
