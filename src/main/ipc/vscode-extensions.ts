/**
 * IPC surface for VS Code-compatible extensions: `vscodeExtensions:*`.
 *
 * Installing runs a native file picker in main rather than accepting a path
 * from the renderer: a renderer-supplied path is a path the user did not
 * necessarily choose, and this reads and copies whatever it is given.
 */
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { z } from 'zod'
import type { VscodeExtensionService } from '../vscode-compat/vscode-extension-service'

const extensionIdSchema = z.object({
  extensionId: z.string().min(1).max(512)
})

const grammarSchema = z.object({
  extensionId: z.string().min(1).max(512),
  scopeName: z.string().min(1).max(256)
})

function broadcastChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('vscodeExtensions:changed')
    }
  }
}

export function registerVscodeExtensionHandlers(service: VscodeExtensionService): void {
  ipcMain.handle('vscodeExtensions:list', async () => service.list())
  ipcMain.handle('vscodeExtensions:contributions', async () => service.contributions())

  ipcMain.handle('vscodeExtensions:installFromVsix', async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Install extension from VSIX',
      properties: ['openFile'],
      filters: [{ name: 'VS Code extension', extensions: ['vsix'] }]
    })
    if (picked.canceled || picked.filePaths.length === 0) {
      return { ok: false, canceled: true }
    }
    const result = service.installFromVsix(picked.filePaths[0]!)
    if (result.ok) {
      broadcastChanged()
    }
    return result
  })

  ipcMain.handle('vscodeExtensions:installFromDirectory', async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Install extension from folder',
      properties: ['openDirectory']
    })
    if (picked.canceled || picked.filePaths.length === 0) {
      return { ok: false, canceled: true }
    }
    const result = service.installFromDirectory(picked.filePaths[0]!)
    if (result.ok) {
      broadcastChanged()
    }
    return result
  })

  ipcMain.handle('vscodeExtensions:remove', async (_event, args: unknown) => {
    const removed = service.remove(extensionIdSchema.parse(args).extensionId)
    if (removed) {
      broadcastChanged()
    }
    return { removed }
  })

  ipcMain.handle('vscodeExtensions:readGrammar', async (_event, args: unknown) => {
    const { extensionId, scopeName } = grammarSchema.parse(args)
    return service.readGrammar(extensionId, scopeName)
  })
}
