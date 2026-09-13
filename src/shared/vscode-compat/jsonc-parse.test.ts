import { describe, expect, it } from 'vitest'
import { parseJsonc, stripJsonComments } from './jsonc-parse'

describe('stripJsonComments', () => {
  it('removes a line comment', () => {
    expect(stripJsonComments('{\n  // a note\n  "a": 1\n}')).toContain('"a": 1')
    expect(stripJsonComments('{\n  // a note\n  "a": 1\n}')).not.toContain('note')
  })

  it('removes a block comment', () => {
    expect(stripJsonComments('{/* hi */ "a": 1}')).not.toContain('hi')
  })

  it('removes a trailing comma before a brace or bracket', () => {
    expect(parseJsonc('{"a": 1,}')).toEqual({ ok: true, value: { a: 1 } })
    expect(parseJsonc('[1, 2,]')).toEqual({ ok: true, value: [1, 2] })
    expect(parseJsonc('{"a": [1,], }')).toEqual({ ok: true, value: { a: [1] } })
  })

  it('keeps a // that is inside a string', () => {
    // The naive regex version breaks every extension with a homepage URL.
    expect(parseJsonc('{"url": "https://example.com/x"}')).toEqual({
      ok: true,
      value: { url: 'https://example.com/x' }
    })
  })

  it('keeps a /* that is inside a string', () => {
    expect(parseJsonc('{"pattern": "/*.go"}')).toEqual({
      ok: true,
      value: { pattern: '/*.go' }
    })
  })

  it('keeps a comma inside a string that precedes a brace', () => {
    expect(parseJsonc('{"a": "x,"}')).toEqual({ ok: true, value: { a: 'x,' } })
  })

  it('handles an escaped quote without ending the string early', () => {
    expect(parseJsonc('{"a": "say \\"hi\\" // not a comment"}')).toEqual({
      ok: true,
      value: { a: 'say "hi" // not a comment' }
    })
  })

  it('handles an escaped backslash before a quote', () => {
    expect(parseJsonc('{"a": "back\\\\", "b": 2}')).toEqual({
      ok: true,
      value: { a: 'back\\', b: 2 }
    })
  })

  it('preserves newlines so error offsets stay on the right line', () => {
    const stripped = stripJsonComments('{\n/* one\ntwo */\n"a": 1}')
    expect(stripped.split('\n')).toHaveLength(4)
  })

  it('leaves plain JSON untouched in meaning', () => {
    const json = '{"a":1,"b":[2,3],"c":{"d":"e"}}'
    expect(parseJsonc(json)).toEqual({ ok: true, value: JSON.parse(json) })
  })
})

describe('parseJsonc', () => {
  it('parses a realistic language-configuration file', () => {
    const raw = `{
  // Go language configuration
  "comments": {
    "lineComment": "//",
    "blockComment": ["/*", "*/"]
  },
  "brackets": [["{", "}"], ["[", "]"], ["(", ")"]],
  "autoClosingPairs": [
    { "open": "{", "close": "}" },
    { "open": "\\"", "close": "\\"", "notIn": ["string"] },
  ],
}`
    const result = parseJsonc<{ comments: { lineComment: string } }>(raw)
    expect(result.ok).toBe(true)
    expect(result.ok && result.value.comments.lineComment).toBe('//')
  })

  it('reports a genuine syntax error rather than throwing', () => {
    const result = parseJsonc('{"a": }')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toBeTruthy()
  })

  it('reports an empty file as an error', () => {
    expect(parseJsonc('').ok).toBe(false)
  })

  it('reports a comment-only file as an error', () => {
    expect(parseJsonc('// nothing here').ok).toBe(false)
  })
})
