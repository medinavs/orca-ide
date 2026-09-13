import { describe, expect, it } from 'vitest'
import { buildContentChanges, endPositionOf } from './language-server-document-sync'

describe('endPositionOf', () => {
  it('reports the end of a single-line document', () => {
    expect(endPositionOf('package main')).toEqual({ line: 0, character: 12 })
  })

  it('reports the end of an empty document', () => {
    expect(endPositionOf('')).toEqual({ line: 0, character: 0 })
  })

  it('counts lines from LF and leaves CR in the column, as LSP does', () => {
    expect(endPositionOf('a\r\nbb')).toEqual({ line: 1, character: 2 })
  })

  it('puts the position on a new empty line after a trailing newline', () => {
    expect(endPositionOf('a\nb\n')).toEqual({ line: 2, character: 0 })
  })

  it('counts UTF-16 code units, so an astral character is two columns', () => {
    // Monaco columns are UTF-16 too; counting code points would drift by one
    // per emoji and land every later diagnostic on the wrong column.
    expect(endPositionOf('x🙂')).toEqual({ line: 0, character: 3 })
  })
})

describe('buildContentChanges', () => {
  it('sends the whole text for full sync', () => {
    expect(buildContentChanges(1, 'old', 'new')).toEqual([{ text: 'new' }])
  })

  it('sends nothing when the server declined sync', () => {
    expect(buildContentChanges(0, 'old', 'new')).toEqual([])
  })

  it('spans the previous text for incremental sync', () => {
    expect(buildContentChanges(2, 'one\ntwo', 'x')).toEqual([
      { range: { start: { line: 0, character: 0 }, end: { line: 1, character: 3 } }, text: 'x' }
    ])
  })

  it('measures the range against the previous text, never the next one', () => {
    // Using the new length here is the classic off-by-a-document bug: the
    // server would keep a tail of the old buffer it was told to replace.
    const [change] = buildContentChanges(2, 'a'.repeat(40), 'b')
    expect(change).toMatchObject({ range: { end: { line: 0, character: 40 } } })
  })
})
