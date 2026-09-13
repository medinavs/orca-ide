import { describe, expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { annotateUriPaths, withDocumentUri } from './lsp-uri-normalization'

const LOCAL = process.platform === 'win32' ? 'C:\\repo\\main.go' : '/repo/main.go'
const LOCAL_URI = pathToFileURL(LOCAL).href

describe('withDocumentUri', () => {
  it('fills in the uri for a textDocument request', () => {
    const params = withDocumentUri(
      'textDocument/hover',
      { position: { line: 3, character: 1 } },
      LOCAL
    ) as { textDocument: { uri: string }; position: unknown }
    expect(params.textDocument.uri).toBe(LOCAL_URI)
    expect(params.position).toEqual({ line: 3, character: 1 })
  })

  it('encodes a Windows drive path as a file URI', () => {
    const params = withDocumentUri('textDocument/hover', {}, LOCAL) as {
      textDocument: { uri: string }
    }
    expect(params.textDocument.uri.startsWith('file:///')).toBe(true)
  })

  it('accepts absent params', () => {
    expect(withDocumentUri('textDocument/documentSymbol', undefined, LOCAL)).toEqual({
      textDocument: { uri: LOCAL_URI }
    })
  })

  it('keeps other textDocument fields the caller set', () => {
    const params = withDocumentUri(
      'textDocument/didChange',
      { textDocument: { version: 4 } },
      LOCAL
    ) as { textDocument: { uri: string; version: number } }
    expect(params.textDocument).toEqual({ version: 4, uri: LOCAL_URI })
  })

  it('leaves a document-less method untouched', () => {
    // `workspace/symbol` addresses the workspace; giving it a uri would be a lie.
    expect(withDocumentUri('workspace/symbol', { query: 'Greet' }, LOCAL)).toEqual({
      query: 'Greet'
    })
    expect(withDocumentUri('completionItem/resolve', { label: 'x' }, LOCAL)).toEqual({
      label: 'x'
    })
  })
})

describe('annotateUriPaths', () => {
  it('adds a host path beside a Location uri', () => {
    const annotated = annotateUriPaths({
      uri: LOCAL_URI,
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } }
    })
    expect(annotated).toMatchObject({ uri: LOCAL_URI, path: LOCAL })
  })

  it('annotates every entry of a Location array', () => {
    const annotated = annotateUriPaths<{ uri: string; path?: string }[]>([
      { uri: LOCAL_URI },
      { uri: LOCAL_URI }
    ])
    expect(annotated.every((entry) => entry.path === LOCAL)).toBe(true)
  })

  it('reaches a uri nested inside related information', () => {
    const annotated = annotateUriPaths({
      message: 'redeclared',
      relatedInformation: [{ location: { uri: LOCAL_URI }, message: 'first here' }]
    }) as { relatedInformation: { location: { path?: string } }[] }
    expect(annotated.relatedInformation[0]!.location.path).toBe(LOCAL)
  })

  it('reaches a uri inside a workspace edit documentChanges entry', () => {
    const annotated = annotateUriPaths({
      documentChanges: [{ textDocument: { uri: LOCAL_URI, version: 2 }, edits: [] }]
    }) as { documentChanges: { textDocument: { path?: string } }[] }
    expect(annotated.documentChanges[0]!.textDocument.path).toBe(LOCAL)
  })

  it('leaves a non-file uri without a path rather than inventing one', () => {
    const annotated = annotateUriPaths<{ uri: string; path?: string }>({
      uri: 'untitled:Untitled-1'
    })
    expect(annotated.path).toBeUndefined()
    expect(annotated.uri).toBe('untitled:Untitled-1')
  })

  it('does not overwrite a path the server already sent', () => {
    const annotated = annotateUriPaths({ uri: LOCAL_URI, path: 'server-supplied' })
    expect(annotated.path).toBe('server-supplied')
  })

  it('passes scalars and null through', () => {
    expect(annotateUriPaths(null)).toBeNull()
    expect(annotateUriPaths(7)).toBe(7)
    expect(annotateUriPaths('text')).toBe('text')
  })

  it('stops at the depth cap instead of hanging on a cycle', () => {
    const cyclic: Record<string, unknown> = { uri: LOCAL_URI }
    cyclic.self = cyclic
    expect(() => annotateUriPaths(cyclic)).not.toThrow()
  })
})
