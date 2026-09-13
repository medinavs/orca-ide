import { expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { findExecutableOnPath } from './language-server-executable'
import { findNativeTypeScriptServer } from './typescript-native-server'
import { createLanguageServerService, localDocumentRef } from './language-server-service'

const legacyServer = findExecutableOnPath('typescript-language-server')
const nativeServer = findNativeTypeScriptServer(process.cwd(), process.env)

it.for([
  {
    name: 'TypeScript 7 native',
    available: nativeServer !== null,
    overrides: { typescript: { command: [nativeServer ?? '', '--lsp', '--stdio'] } }
  },
  {
    name: 'TypeScript 6 wrapper',
    available: legacyServer !== null,
    overrides: {
      typescript: {
        command: [legacyServer ?? '', '--stdio'],
        initializationOptions: {
          tsserver: {
            path: createRequire(import.meta.url).resolve('typescript-api/lib/tsserver.js')
          }
        }
      }
    }
  }
])(
  'reports errors, clears fixes, and restarts with $name',
  { timeout: 60000 },
  async ({ available, overrides }, context) => {
    if (!available) {
      context.skip()
    }
    const root = mkdtempSync(join(tmpdir(), 'orca-typescript-'))
    const service = createLanguageServerService({ overrides: () => overrides })
    try {
      writeFileSync(
        join(root, 'tsconfig.json'),
        '{"compilerOptions":{"strict":true,"jsx":"preserve"}}'
      )
      const path = join(root, 'index.ts')
      const text = 'export const count: number = "wrong";\n'
      writeFileSync(path, text)
      service.openDocument(localDocumentRef(root, path, 'typescript'), text)
      await expect.poll(() => service.statuses()[0]?.state, { timeout: 15000 }).toBe('running')
      await expect
        .poll(
          () =>
            service
              .diagnosticsSnapshot(root)
              .files.flatMap((file) => file.diagnostics)
              .map((d) => d.code),
          { timeout: 20000 }
        )
        .toContain(2322)
      const ref = localDocumentRef(root, path, 'typescript')
      service.changeDocument(ref, 'export const count: number = 42;\n')
      await expect
        .poll(() => service.diagnosticsSnapshot(root).files, { timeout: 20000 })
        .toEqual([])
      service.changeDocument(ref, text)
      await service.restart({ executionHostId: 'local', rootPath: root, serverId: 'typescript' })
      expect(service.statuses()[0]?.state).toBe('running')
      await expect
        .poll(
          () =>
            service
              .diagnosticsSnapshot(root)
              .files.flatMap((file) => file.diagnostics)
              .map((d) => d.code),
          { timeout: 20000 }
        )
        .toContain(2322)
      const tsxPath = join(root, 'component.tsx')
      const tsx =
        'declare global { namespace JSX { interface IntrinsicElements { div: unknown } } }\nexport const element = <div/>;\nexport const count: number = "wrong";'
      writeFileSync(tsxPath, tsx)
      service.openDocument(localDocumentRef(root, tsxPath, 'typescript'), tsx)
      await expect
        .poll(
          () =>
            service
              .diagnosticsSnapshot(root)
              .files.find((file) => file.path === tsxPath)
              ?.diagnostics.map((d) => d.code),
          { timeout: 20000 }
        )
        .toEqual([2322])
    } finally {
      await service.dispose('test teardown')
      rmSync(root, { recursive: true, force: true })
    }
  }
)
