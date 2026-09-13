/**
 * The set of documents one session has told its server about, and the four
 * `textDocument/*` notifications that keep the server's copy in step.
 *
 * Tracked separately from the connection on purpose: a document can be opened
 * while the handshake is still in flight, and the session replays this registry
 * once the server is ready. Version numbers therefore come from here, not from
 * the wire, and survive a restart.
 */
import { pathToFileURL } from 'node:url'
import type { LspConnection } from '../../shared/lsp/lsp-connection'
import { buildContentChanges } from './language-server-document-sync'

export type OpenDocumentRecord = { version: number; text: string; languageId: string }

export type LanguageServerDocuments = {
  open(path: string, languageId: string, text: string): void
  change(path: string, text: string): void
  close(path: string): void
  save(path: string): void
  isOpen(path: string): boolean
  paths(): string[]
  entries(): [string, OpenDocumentRecord][]
  clear(): void
}

export type LanguageServerDocumentsOptions = {
  /** Null while starting, failed or stopped — notifications are then dropped. */
  connection: () => LspConnection | null
  /** The server's declared sync kind; `1` until the handshake says otherwise. */
  syncKind: () => 0 | 1 | 2
}

export function createLanguageServerDocuments(
  options: LanguageServerDocumentsOptions
): LanguageServerDocuments {
  const documents = new Map<string, OpenDocumentRecord>()
  const uriFor = (path: string): string => pathToFileURL(path).href

  return {
    open(path, languageId, text) {
      // Reopening keeps counting up: a server rejects a version that went
      // backwards, and a re-open after a restart is the common case.
      const version = (documents.get(path)?.version ?? 0) + 1
      documents.set(path, { version, text, languageId })
      options.connection()?.notify('textDocument/didOpen', {
        textDocument: { uri: uriFor(path), languageId, version, text }
      })
    },

    change(path, text) {
      const existing = documents.get(path)
      if (!existing || existing.text === text) {
        return
      }
      const version = existing.version + 1
      const changes = buildContentChanges(options.syncKind(), existing.text, text)
      documents.set(path, { ...existing, version, text })
      if (changes.length === 0) {
        return
      }
      options.connection()?.notify('textDocument/didChange', {
        textDocument: { uri: uriFor(path), version },
        contentChanges: changes
      })
    },

    close(path) {
      if (!documents.delete(path)) {
        return
      }
      options.connection()?.notify('textDocument/didClose', {
        textDocument: { uri: uriFor(path) }
      })
    },

    save(path) {
      const existing = documents.get(path)
      if (!existing) {
        return
      }
      options.connection()?.notify('textDocument/didSave', {
        textDocument: { uri: uriFor(path) },
        text: existing.text
      })
    },

    isOpen: (path) => documents.has(path),
    paths: () => [...documents.keys()],
    entries: () => [...documents.entries()],
    clear: () => documents.clear()
  }
}
