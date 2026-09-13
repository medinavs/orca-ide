import { afterEach, describe, expect, it } from 'vitest'
import type { editor } from 'monaco-editor'
import type { LanguageDocumentRef } from '../../../../preload/api/language-server-api'
import {
  clearLspDocumentRegistry,
  lspDocumentForModel,
  lspDocumentRegistrySize,
  registerLspDocument,
  unregisterLspDocument
} from './lsp-document-registry'

function model(uri: string): editor.ITextModel {
  return { uri: { toString: () => uri } } as unknown as editor.ITextModel
}

const REF: LanguageDocumentRef = {
  executionHostId: 'local',
  rootPath: '/repo',
  path: '/repo/main.go',
  languageId: 'go'
}

afterEach(clearLspDocumentRegistry)

describe('lsp document registry', () => {
  it('returns the ref recorded for a model', () => {
    registerLspDocument(model('file:///repo/main.go'), REF)
    expect(lspDocumentForModel(model('file:///repo/main.go'))).toEqual(REF)
  })

  it('matches by URI string, so a recreated model for the same path resolves', () => {
    // Monaco can dispose and recreate a model for one path; keying by object
    // identity would silently lose every language feature after that.
    registerLspDocument(model('file:///repo/main.go'), REF)
    const recreated = model('file:///repo/main.go')
    expect(lspDocumentForModel(recreated)).toEqual(REF)
  })

  it('returns null for an unbound model', () => {
    expect(lspDocumentForModel(model('file:///repo/other.go'))).toBeNull()
  })

  it('forgets a model on unregister', () => {
    const target = model('file:///repo/main.go')
    registerLspDocument(target, REF)
    unregisterLspDocument(target)
    expect(lspDocumentForModel(target)).toBeNull()
    expect(lspDocumentRegistrySize()).toBe(0)
  })

  it('replaces the ref when the same model is reopened', () => {
    const target = model('file:///repo/main.go')
    registerLspDocument(target, REF)
    registerLspDocument(target, { ...REF, languageId: 'plaintext' })
    expect(lspDocumentForModel(target)?.languageId).toBe('plaintext')
    expect(lspDocumentRegistrySize()).toBe(1)
  })

  it('keeps several documents apart', () => {
    registerLspDocument(model('file:///repo/a.go'), REF)
    registerLspDocument(model('file:///repo/b.go'), { ...REF, path: '/repo/b.go' })
    expect(lspDocumentForModel(model('file:///repo/b.go'))?.path).toBe('/repo/b.go')
    expect(lspDocumentRegistrySize()).toBe(2)
  })

  it('tolerates unregistering a model that was never registered', () => {
    expect(() => unregisterLspDocument(model('file:///nope'))).not.toThrow()
  })
})
