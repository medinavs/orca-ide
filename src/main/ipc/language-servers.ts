/**
 * IPC surface for the language-server service: `lsp:*`.
 *
 * Follows the plugin handlers' shape — zod-validated args, a service owned by
 * main, and pushed change events — because the renderer must never be the
 * authority for a process lifecycle it cannot observe.
 *
 * Diagnostics are pushed rather than polled: the renderer has four surfaces to
 * update and no way to know when gopls finishes analysing.
 */
import { BrowserWindow, ipcMain } from 'electron'
import { z } from 'zod'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import type { LanguageServerService } from '../lsp/language-server-service'

/** Matches `ExecutionHostId`: `local`, `ssh:<id>` or `runtime:<id>`. */
const executionHostIdSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value): value is ExecutionHostId =>
      value === LOCAL_EXECUTION_HOST_ID || value.startsWith('ssh:') || value.startsWith('runtime:'),
    'not an execution host id'
  )

const documentRefSchema = z.object({
  executionHostId: executionHostIdSchema,
  rootPath: z.string().min(1).max(4096),
  path: z.string().min(1).max(4096),
  languageId: z.string().min(1).max(128)
})

/** Generous but bounded: a renderer must not be able to pass an unbounded buffer. */
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024

const documentTextSchema = z.object({
  ref: documentRefSchema,
  text: z.string().max(MAX_DOCUMENT_BYTES)
})

const featureRequestSchema = z.object({
  ref: documentRefSchema,
  method: z.string().min(1).max(128),
  params: z.unknown().optional()
})

const workspaceSchema = z.object({
  executionHostId: executionHostIdSchema,
  rootPath: z.string().min(1).max(4096)
})

const snapshotSchema = z.object({ rootPath: z.string().min(1).max(4096) })

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, payload)
    }
  }
}

export function registerLanguageServerHandlers(service: LanguageServerService): void {
  ipcMain.handle('lsp:openDocument', async (_event, args: unknown) => {
    const { ref, text } = documentTextSchema.parse(args)
    return service.openDocument(ref, text)
  })

  ipcMain.handle('lsp:changeDocument', async (_event, args: unknown) => {
    const { ref, text } = documentTextSchema.parse(args)
    service.changeDocument(ref, text)
  })

  ipcMain.handle('lsp:saveDocument', async (_event, args: unknown) => {
    service.saveDocument(documentRefSchema.parse(args))
  })

  ipcMain.handle('lsp:closeDocument', async (_event, args: unknown) => {
    service.closeDocument(documentRefSchema.parse(args))
  })

  ipcMain.handle('lsp:request', async (_event, args: unknown) => {
    const { ref, method, params } = featureRequestSchema.parse(args)
    // The allowlist inside the service — not this schema — decides which
    // methods are forwardable; keeping it there means the headless runtime
    // gets the same gate.
    return service.requestFeature(ref, method, params)
  })

  ipcMain.handle('lsp:diagnostics', async (_event, args: unknown) =>
    service.diagnosticsSnapshot(snapshotSchema.parse(args).rootPath)
  )

  ipcMain.handle('lsp:statuses', async () => service.statuses())

  ipcMain.handle('lsp:restart', async (_event, args: unknown) => {
    await service.restart(
      workspaceSchema.extend({ serverId: z.string().min(1).max(128) }).parse(args)
    )
  })

  ipcMain.handle('lsp:stopWorkspace', async (_event, args: unknown) => {
    await service.stopWorkspace(workspaceSchema.parse(args))
  })

  service.diagnostics.subscribe((snapshot) => broadcast('lsp:diagnosticsChanged', snapshot))
  service.onStatusChanged((status) => broadcast('lsp:statusChanged', status))
}
