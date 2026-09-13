import { pathToFileURL } from 'node:url'
import type { LspConnection } from '../../shared/lsp/lsp-connection'
import type { LspDiagnostic } from '../../shared/lsp/lsp-protocol-types'
import type { LanguageServerDocuments } from './language-server-documents'
import type { ServerDiagnosticsPublication } from './language-server-transport'

export function createPullDiagnostics(options: {
  connection: () => LspConnection | null
  documents: LanguageServerDocuments
  publish?: (publication: ServerDiagnosticsPublication) => void
  onLog?: (line: string) => void
}): { refresh: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | undefined

  function cancel(): void {
    clearTimeout(timer)
    controller?.abort()
  }

  return {
    cancel,
    refresh() {
      cancel()
      if (!options.connection()) {
        return
      }
      const current = new AbortController()
      controller = current
      timer = setTimeout(() => {
        const connection = options.connection()
        if (!connection) {
          return
        }
        for (const [path, document] of options.documents.entries()) {
          void connection
            .request<{ kind: string; items?: LspDiagnostic[] }>(
              'textDocument/diagnostic',
              { textDocument: { uri: pathToFileURL(path).href } },
              AbortSignal.any([current.signal, AbortSignal.timeout(30000)])
            )
            .then((report) => {
              if (current.signal.aborted || !options.documents.isOpen(path)) {
                return
              }
              if (report.kind === 'full' && Array.isArray(report.items)) {
                options.publish?.({ path, version: document.version, diagnostics: report.items })
              }
            })
            .catch((error) => {
              if (!current.signal.aborted) {
                options.onLog?.(`Diagnostic request failed: ${String(error)}`)
              }
            })
        }
      }, 250)
      timer.unref?.()
    }
  }
}
