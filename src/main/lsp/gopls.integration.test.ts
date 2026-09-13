/**
 * End-to-end proof against the real `gopls`, not a mock: a temp Go module is
 * written to disk, gopls is started against it, and the editor-facing features
 * are driven through the same service the renderer uses.
 *
 * Skipped when gopls is not on PATH, so it never fails a machine that has no
 * Go toolchain. `pnpm test src/main/lsp/gopls.integration.test.ts` runs it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  LspCompletionList,
  LspDocumentSymbol,
  LspHover,
  LspLocation,
  LspTextEdit
} from '../../shared/lsp/lsp-protocol-types'
import { findExecutableOnPath } from './language-server-executable'
import {
  createLanguageServerService,
  localDocumentRef,
  type LanguageServerService
} from './language-server-service'

const GOPLS = findExecutableOnPath('gopls')
const HAS_GOPLS = GOPLS !== null
const READY_TIMEOUT_MS = 120_000

/** A tiny module with one deliberate error: `Missing` is never declared. */
const BROKEN_GO = `package main

import "fmt"

func Greet(name string) string {
	return fmt.Sprintf("hello %s", name)
}

func main() {
	fmt.Println(Greet("world"))
	Missing()
}
`

let root: string
let service: LanguageServerService
let mainGo: string

beforeAll(async () => {
  if (!HAS_GOPLS) {
    return
  }
  root = mkdtempSync(join(tmpdir(), 'orca-gopls-'))
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'go.mod'), 'module orca.test/probe\n\ngo 1.21\n')
  mainGo = join(root, 'main.go')
  writeFileSync(mainGo, BROKEN_GO)
  service = createLanguageServerService({
    caseInsensitivePaths: process.platform === 'win32'
  })
}, READY_TIMEOUT_MS)

afterAll(async () => {
  await service?.dispose('test teardown')
  if (root !== undefined) {
    rmSync(root, { recursive: true, force: true })
  }
}, READY_TIMEOUT_MS)

function ref(): ReturnType<typeof localDocumentRef> {
  return localDocumentRef(root, mainGo, 'go')
}

/**
 * Waits for something that depends on gopls finishing analysis. The probe may
 * be async — awaited each round, so a request-based probe is retried rather
 * than resolving instantly with its own pending promise.
 */
async function until<T>(
  probe: () => T | null | Promise<T | null>,
  label: string
): Promise<T> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  for (;;) {
    const value = await probe()
    if (value !== null && value !== undefined) {
      return value
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

describe.runIf(HAS_GOPLS)('gopls integration', () => {
  it('starts gopls for a module and reports it running', async () => {
    const opened = service.openDocument(ref(), BROKEN_GO)
    expect(opened).toMatchObject({ ok: true, serverId: 'gopls' })
    const status = await until(
      () => service.statuses().find((entry) => entry.state === 'running') ?? null,
      'gopls to finish initializing'
    )
    expect(status.serverInfo?.name ?? 'gopls').toContain('gopls')
    // The capabilities drive every feature gate, so assert the ones Orca uses.
    expect(status.capabilities).toMatchObject({
      hoverProvider: expect.anything(),
      definitionProvider: expect.anything(),
      referencesProvider: expect.anything(),
      documentSymbolProvider: expect.anything(),
      documentFormattingProvider: expect.anything()
    })
  })

  it('publishes a diagnostic for the undeclared call', async () => {
    const snapshot = await until(() => {
      const files = service.diagnosticsSnapshot(root).files
      return files.length > 0 ? files : null
    }, 'gopls diagnostics')
    const messages = snapshot.flatMap((file) => file.diagnostics.map((entry) => entry.message))
    expect(messages.join('\n')).toMatch(/Missing/)
    expect(snapshot[0]!.relativePath).toBe('main.go')
    expect(snapshot[0]!.diagnostics[0]).toMatchObject({ serverId: 'gopls' })
  })

  it('clears the diagnostic once the code is fixed', async () => {
    service.changeDocument(ref(), BROKEN_GO.replace('\tMissing()\n', ''))
    await until(
      () => (service.diagnosticsSnapshot(root).files.length === 0 ? true : null),
      'diagnostics to clear after the fix'
    )
    expect(service.diagnosticsSnapshot(root).files).toEqual([])
    // Put the error back so later cases see the original document.
    service.changeDocument(ref(), BROKEN_GO)
  })

  it('answers hover with documentation for a symbol', async () => {
    const hover = await until(async () => {
      const answer = await service.requestFeature<LspHover | null>(
        ref(),
        'textDocument/hover',
        // `Greet` on the `fmt.Println(Greet(...))` line.
        { position: { line: 9, character: 14 } }
      )
      return answer.ok && answer.result ? answer.result : null
    }, 'a hover answer')
    const contents = (await hover) as LspHover
    const text =
      typeof contents.contents === 'string'
        ? contents.contents
        : JSON.stringify(contents.contents)
    expect(text).toMatch(/Greet/)
  })

  it('resolves go to definition within the module', async () => {
    const answer = await service.requestFeature<LspLocation | LspLocation[]>(
      ref(),
      'textDocument/definition',
      { position: { line: 9, character: 14 } }
    )
    expect(answer.ok).toBe(true)
    const locations = answer.ok
      ? Array.isArray(answer.result)
        ? answer.result
        : [answer.result]
      : []
    expect(locations[0]?.uri).toMatch(/main\.go$/)
    // `Greet` is declared on line 5 (0-based 4).
    expect(locations[0]?.range.start.line).toBe(4)
  })

  it('finds references to a declaration', async () => {
    const answer = await service.requestFeature<LspLocation[]>(ref(), 'textDocument/references', {
      position: { line: 4, character: 5 },
      context: { includeDeclaration: true }
    })
    expect(answer.ok).toBe(true)
    expect(answer.ok && answer.result.length).toBeGreaterThanOrEqual(2)
  })

  it('lists document symbols', async () => {
    const answer = await service.requestFeature<LspDocumentSymbol[]>(
      ref(),
      'textDocument/documentSymbol'
    )
    expect(answer.ok).toBe(true)
    const names = answer.ok ? answer.result.map((symbol) => symbol.name) : []
    expect(names).toEqual(expect.arrayContaining(['Greet', 'main']))
  })

  it('offers completions after a package selector', async () => {
    const answer = await service.requestFeature<LspCompletionList>(
      ref(),
      'textDocument/completion',
      { position: { line: 9, character: 5 }, context: { triggerKind: 1 } }
    )
    expect(answer.ok).toBe(true)
    expect(answer.ok && answer.result.items.length).toBeGreaterThan(0)
  })

  it('formats the document through gopls', async () => {
    const unformatted = BROKEN_GO.replace('func main() {', 'func   main(  ) {')
    service.changeDocument(ref(), unformatted)
    const answer = await service.requestFeature<LspTextEdit[]>(ref(), 'textDocument/formatting', {
      options: { tabSize: 4, insertSpaces: false }
    })
    expect(answer.ok).toBe(true)
    expect(answer.ok && answer.result.length).toBeGreaterThan(0)
    service.changeDocument(ref(), BROKEN_GO)
  })

  it('answers in the shapes the Monaco conversions assume', async () => {
    // The renderer's converters branch on these shapes (MarkupContent vs bare
    // string, single Location vs array, hierarchical vs flat symbols). Unit
    // tests cover each branch with hand-written fixtures; this pins which
    // branch a real server actually takes, so a fixture drifting from reality
    // fails here rather than silently in the editor.
    const hover = await service.requestFeature<{ contents: unknown }>(
      ref(),
      'textDocument/hover',
      { position: { line: 9, character: 14 } }
    )
    expect(hover.ok).toBe(true)
    const contents = hover.ok ? hover.result.contents : null
    expect(typeof contents === 'object' && contents !== null).toBe(true)
    expect(contents).toMatchObject({ kind: expect.any(String), value: expect.any(String) })

    const symbols = await service.requestFeature<Record<string, unknown>[]>(
      ref(),
      'textDocument/documentSymbol'
    )
    expect(symbols.ok).toBe(true)
    // `selectionRange` is what distinguishes DocumentSymbol from the flat
    // legacy SymbolInformation form.
    expect(symbols.ok && symbols.result[0]).toHaveProperty('selectionRange')

    const definition = await service.requestFeature<unknown>(ref(), 'textDocument/definition', {
      position: { line: 9, character: 14 }
    })
    expect(definition.ok).toBe(true)
    // gopls answers with an array; `toLocationArray` also accepts a lone object.
    expect(Array.isArray(definition.ok ? definition.result : null)).toBe(true)

    // Every returned uri is annotated with a host path by main, so the
    // renderer never parses a file:// URI itself.
    const locations = (definition.ok ? definition.result : []) as { path?: string }[]
    expect(locations[0]?.path).toMatch(/main\.go$/)
  })

  it('reports an unsupported feature instead of failing the request', async () => {
    // gopls advertises no `workspace/executeCommand` through Orca's allowlist.
    const answer = await service.requestFeature(ref(), 'workspace/executeCommand', {})
    expect(answer).toMatchObject({ ok: false, reason: 'unsupported' })
  })

  it('stops gopls and clears its diagnostics on workspace close', async () => {
    await service.stopWorkspace({ executionHostId: 'local', rootPath: root })
    expect(service.statuses()).toEqual([])
    expect(service.diagnosticsSnapshot(root).files).toEqual([])
  })
})

describe.runIf(!HAS_GOPLS)('gopls integration', () => {
  it('is skipped without gopls on PATH', () => {
    expect(GOPLS).toBeNull()
  })
})
