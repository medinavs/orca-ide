import { useEffect, useState } from 'react'
import { RotateCw } from 'lucide-react'
import { Button } from '../ui/button'
import { translate } from '@/i18n/i18n'
import { startLspDiagnosticsSubscription, useLspDiagnosticsStore } from '@/store/lsp-diagnostics'
import type { LanguageServerStatus } from '../../../../shared/lsp/language-server-status'

export function LanguageServersSettingsPane(): React.JSX.Element {
  const statuses = useLspDiagnosticsStore((state) => state.serverStatuses)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [showProgress, setShowProgress] = useState(false)

  useEffect(() => {
    setShowProgress(false)
    if (busy === null) {
      return
    }
    const timer = setTimeout(() => setShowProgress(true), 200)
    return () => clearTimeout(timer)
  }, [busy])

  useEffect(() => {
    let active = true
    startLspDiagnosticsSubscription()
    const api = window.api?.languageServers
    if (!api) {
      setError(
        translate('settings.lsp.unavailable', 'Language servers are unavailable in this client.')
      )
      setLoading(false)
      return
    }
    void api
      .statuses()
      .then((snapshot) => {
        if (!active) {
          return
        }
        for (const status of snapshot) {
          useLspDiagnosticsStore.getState().applyStatus(status)
        }
      })
      .catch((error) => {
        if (active) {
          setError(String(error))
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false)
        }
      })
    return () => {
      active = false
    }
  }, [])

  const restart = async (key: string, status: LanguageServerStatus): Promise<void> => {
    setBusy(key)
    setError(null)
    try {
      await window.api.languageServers.restart({
        executionHostId: 'local',
        rootPath: status.rootPath,
        serverId: status.serverId
      })
    } catch (error) {
      setError(String(error))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        {translate(
          'settings.lsp.scope',
          'Servers start when you open a supported file in a local workspace. Install the server on PATH, then use Restart to retry. SSH and remote workspaces do not support language servers yet.'
        )}
      </p>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {loading ? (
        <p className="text-xs text-muted-foreground">
          {translate('settings.lsp.loading', 'Loading language servers…')}
        </p>
      ) : Object.keys(statuses).length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {translate(
            'settings.lsp.empty',
            'Open a source file to start its language server. Server status and restart controls will appear here.'
          )}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {Object.entries(statuses).map(([key, status]) => (
            <li key={key} className="flex flex-col gap-2 py-3">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{status.label}</p>
                  <p className="break-all text-xs text-muted-foreground">{status.rootPath}</p>
                  <p className="mt-1 text-xs text-muted-foreground" role="status">
                    {
                      {
                        starting: translate('settings.lsp.starting', 'Starting…'),
                        running: translate('settings.lsp.running', 'Running'),
                        'not-installed': translate('settings.lsp.notInstalled', 'Not installed'),
                        failed: translate('settings.lsp.failed', 'Failed'),
                        stopped: translate('settings.lsp.stopped', 'Stopped')
                      }[status.state]
                    }
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-28 shrink-0"
                  disabled={busy !== null || status.state === 'stopped'}
                  onClick={() => void restart(key, status)}
                  aria-label={`${translate('settings.lsp.restart', 'Restart')} ${status.label} — ${status.rootPath}`}
                >
                  <RotateCw className="size-3.5" aria-hidden />
                  {busy === key && showProgress
                    ? translate('settings.lsp.restarting', 'Restarting…')
                    : translate('settings.lsp.restart', 'Restart')}
                </Button>
              </div>
              {status.message && <p className="text-xs text-muted-foreground">{status.message}</p>}
              {status.installHint && (
                <p className="break-words font-mono text-xs">{status.installHint}</p>
              )}
              {status.stderrTail && (
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs text-muted-foreground scrollbar-sleek">
                  {status.stderrTail}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
