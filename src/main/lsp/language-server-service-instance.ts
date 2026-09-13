/**
 * Process-wide handle on the language-server service.
 *
 * A singleton because the thing it owns is a set of OS processes: two services
 * would start two goplses per module and publish two sets of diagnostics for
 * the same file. App shutdown reaches it through `disposeLanguageServerService`.
 */
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { LanguageServerOverrides } from '../../shared/lsp/language-server-catalog'
import {
  createLanguageServerService,
  type LanguageServerService
} from './language-server-service'

let instance: LanguageServerService | null = null

/** Windows and macOS default to case-insensitive filesystems. */
function localPathsAreCaseInsensitive(): boolean {
  return process.platform === 'win32' || process.platform === 'darwin'
}

export function languageServerOverridesFromSettings(
  settings: Pick<GlobalSettings, 'languageServers'>
): LanguageServerOverrides {
  return settings.languageServers ?? {}
}

export type LanguageServerServiceHost = {
  getSettings: () => GlobalSettings
}

/**
 * Creates the service unless settings disable LSP entirely. Returns null when
 * disabled, so callers register no IPC and the editor behaves exactly as it
 * did before language support existed.
 */
export function initLanguageServerService(
  host: LanguageServerServiceHost
): LanguageServerService | null {
  if (instance) {
    return instance
  }
  if (host.getSettings().languageServersEnabled === false) {
    return null
  }
  instance = createLanguageServerService({
    // Read through on every start: a settings edit takes effect on the next
    // server launch without an app restart.
    overrides: () => languageServerOverridesFromSettings(host.getSettings()),
    caseInsensitivePaths: localPathsAreCaseInsensitive(),
    onLog: (line) => console.warn(line)
  })
  return instance
}

export function getLanguageServerService(): LanguageServerService | null {
  return instance
}

export async function disposeLanguageServerService(reason: string): Promise<void> {
  const current = instance
  instance = null
  await current?.dispose(reason)
}
