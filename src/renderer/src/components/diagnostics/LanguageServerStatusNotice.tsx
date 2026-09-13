import React from 'react'
import { translate } from '@/i18n/i18n'
import type { LanguageServerStatus } from '../../../../main/lsp/language-server-session'

/**
 * The graceful-degradation surface: why a language has no diagnostics.
 *
 * Shown inline in the Problems panel rather than as a toast, because "gopls is
 * not installed" is a standing condition with a fix, not an event. A missing
 * server must never read as "your code is clean".
 */
export function LanguageServerStatusNotice({
  statuses
}: {
  statuses: readonly LanguageServerStatus[]
}): React.JSX.Element | null {
  const notable = statuses.filter(
    (status) => status.state === 'not-installed' || status.state === 'failed'
  )
  const starting = statuses.filter((status) => status.state === 'starting')
  if (notable.length === 0 && starting.length === 0) {
    return null
  }
  return (
    <div className="border-b border-border">
      {starting.map((status) => (
        <div
          key={`${status.serverId}-starting`}
          className="px-2 py-1.5 text-xs text-muted-foreground"
        >
          {translate(
            'auto.components.diagnostics.languageServerStarting',
            'Starting {{label}}…'
          ).replace('{{label}}', status.label)}
        </div>
      ))}
      {notable.map((status) => (
        <div key={status.serverId} className="px-2 py-1.5 text-xs">
          <div className="text-diagnostic-warning">{status.message ?? status.label}</div>
          {status.installHint !== undefined && (
            // A copyable command, so the fix does not require leaving Orca to
            // look up the install line.
            <code className="mt-1 block break-all rounded bg-muted px-1 py-0.5 text-[11px] text-muted-foreground">
              {status.installHint}
            </code>
          )}
          {status.documentationUrl !== undefined && (
            <a
              href={status.documentationUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-block text-muted-foreground underline hover:text-foreground"
            >
              {translate('auto.components.diagnostics.languageServerDocs', 'Documentation')}
            </a>
          )}
        </div>
      ))}
    </div>
  )
}
