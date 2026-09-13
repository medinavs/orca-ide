import { expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import type { LspConnection } from '../../shared/lsp/lsp-connection'
import { createLanguageServerDocuments } from './language-server-documents'
import { createPullDiagnostics } from './language-server-pull-diagnostics'

it('drops stale pull replies after edits and closes and publishes the current report', async () => {
  vi.useFakeTimers()
  const publish = vi.fn()
  const request = vi.fn()
  const connection = { request } as unknown as LspConnection
  const documents = createLanguageServerDocuments({ connection: () => null, syncKind: () => 1 })
  const pull = createPullDiagnostics({ connection: () => connection, documents, publish })
  const path = resolve('pull.ts')
  try {
    documents.open(path, 'typescript', 'before')
    let reply!: (value: unknown) => void
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          reply = resolve
        })
    )
    pull.refresh()
    await vi.advanceTimersByTimeAsync(250)
    documents.change(path, 'after')
    pull.refresh()
    reply({ kind: 'full', items: [] })
    await Promise.resolve()
    expect(publish).not.toHaveBeenCalled()
    request.mockResolvedValueOnce({ kind: 'full', items: [] })
    await vi.advanceTimersByTimeAsync(250)
    expect(publish).toHaveBeenCalledWith({ path, version: 2, diagnostics: [] })
    publish.mockClear()
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          reply = resolve
        })
    )
    pull.refresh()
    await vi.advanceTimersByTimeAsync(250)
    documents.close(path)
    reply({ kind: 'full', items: [] })
    await Promise.resolve()
    expect(publish).not.toHaveBeenCalled()
  } finally {
    pull.cancel()
    vi.useRealTimers()
  }
})
