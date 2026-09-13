import { describe, expect, it } from 'vitest'
import {
  createLanguageServerService,
  localDocumentRef,
  type LanguageServerService
} from './language-server-service'
import {
  isLanguageFeatureMethod,
  LANGUAGE_FEATURE_METHODS,
  serverSupportsFeature
} from './language-feature-methods'

const GO_REF = localDocumentRef('/repo', '/repo/main.go', 'go')

/**
 * Points `go` at a command that cannot exist, so the service lands in
 * `not-installed` on every machine. Without the override these tests depend on
 * whether the developer happens to have gopls on PATH — which is exactly the
 * kind of environment-dependent test that passes in CI and fails on a laptop.
 */
function service(): LanguageServerService {
  return createLanguageServerService({
    overrides: () => ({ gopls: { command: ['orca-absent-language-server'] } })
  })
}

describe('language feature allowlist', () => {
  it('accepts the methods the editor uses', () => {
    expect(isLanguageFeatureMethod('textDocument/hover')).toBe(true)
    expect(isLanguageFeatureMethod('textDocument/completion')).toBe(true)
    expect(isLanguageFeatureMethod('textDocument/codeAction')).toBe(true)
  })

  it('refuses anything else, including server-command execution', () => {
    // `workspace/executeCommand` runs server-defined commands; a passthrough
    // channel would hand that to any caller that can reach the renderer.
    expect(isLanguageFeatureMethod('workspace/executeCommand')).toBe(false)
    expect(isLanguageFeatureMethod('shutdown')).toBe(false)
    expect(isLanguageFeatureMethod('exit')).toBe(false)
    expect(isLanguageFeatureMethod('$/cancelRequest')).toBe(false)
  })

  it('covers every method the allowlist advertises', () => {
    for (const method of LANGUAGE_FEATURE_METHODS) {
      expect(isLanguageFeatureMethod(method)).toBe(true)
    }
  })
})

describe('serverSupportsFeature', () => {
  it('reports false for an empty capability set', () => {
    expect(serverSupportsFeature({}, 'textDocument/hover')).toBe(false)
    expect(serverSupportsFeature(undefined, 'textDocument/hover')).toBe(false)
  })

  it('accepts a boolean capability', () => {
    expect(serverSupportsFeature({ hoverProvider: true }, 'textDocument/hover')).toBe(true)
  })

  it('accepts an options-object capability, which is how most servers reply', () => {
    expect(
      serverSupportsFeature({ documentSymbolProvider: { label: 'Go' } }, 'textDocument/documentSymbol')
    ).toBe(true)
  })

  it('treats an explicit false as unsupported', () => {
    expect(serverSupportsFeature({ hoverProvider: false }, 'textDocument/hover')).toBe(false)
  })

  it('gates completion resolve on the nested flag, not the parent', () => {
    expect(
      serverSupportsFeature({ completionProvider: {} }, 'completionItem/resolve')
    ).toBe(false)
    expect(
      serverSupportsFeature(
        { completionProvider: { resolveProvider: true } },
        'completionItem/resolve'
      )
    ).toBe(true)
  })
})

describe('createLanguageServerService', () => {
  it('reports a missing server as a status, not an error', () => {
    const instance = service()
    // A session is created either way; "gopls is not installed" belongs in its
    // status so the UI can show the install hint, not in a thrown error.
    expect(instance.openDocument(GO_REF, 'package main').ok).toBe(true)
    expect(instance.statuses()).toEqual([
      expect.objectContaining({ state: 'not-installed', installHint: expect.any(String) })
    ])
  })

  it('refuses a remote workspace at the service boundary too', () => {
    const result = service().openDocument(
      { ...GO_REF, executionHostId: 'ssh:box' },
      'package main'
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.unavailable.state).toBe('unsupported-host')
  })

  it('answers an unsupported feature request without rejecting', async () => {
    const instance = service()
    const answer = await instance.requestFeature(GO_REF, 'workspace/executeCommand')
    expect(answer).toEqual({
      ok: false,
      reason: 'unsupported',
      message: expect.stringContaining('not a language-feature request')
    })
  })

  it('answers unavailable when no server is running for the document', async () => {
    const answer = await service().requestFeature(GO_REF, 'textDocument/hover')
    expect(answer.ok).toBe(false)
    expect(answer.ok === false && answer.reason).toBe('unavailable')
  })

  it('exposes an empty diagnostics snapshot for an unknown workspace', () => {
    expect(service().diagnosticsSnapshot('/nowhere')).toEqual({
      rootPath: '/nowhere',
      files: []
    })
  })

  it('clears diagnostics when a workspace stops', async () => {
    const instance = service()
    instance.diagnostics.publish({
      rootPath: '/repo',
      serverId: 'gopls',
      path: '/repo/main.go',
      diagnostics: [
        {
          message: 'boom',
          severity: 1,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }
        }
      ]
    })
    await instance.stopWorkspace({ executionHostId: 'local', rootPath: '/repo' })
    expect(instance.diagnosticsSnapshot('/repo').files).toEqual([])
  })

  it('publishes a starting status before the spawn attempt', () => {
    const instance = service()
    const seen: string[] = []
    instance.onStatusChanged((status) => seen.push(status.state))
    instance.openDocument(GO_REF, '')
    // `starting` has to reach the UI synchronously: a cold gopls start on a
    // large module takes seconds, and the editor needs something to show.
    expect(seen[0]).toBe('starting')
    expect(seen).toContain('not-installed')
  })

  it('stops forwarding status after unsubscribe', () => {
    const instance = service()
    const seen: string[] = []
    instance.onStatusChanged((status) => seen.push(status.state))()
    instance.openDocument(GO_REF, '')
    expect(seen).toEqual([])
  })

  it('disposes without throwing', async () => {
    const instance = service()
    instance.openDocument(GO_REF, '')
    await expect(instance.dispose('quit')).resolves.toBeUndefined()
  })
})
