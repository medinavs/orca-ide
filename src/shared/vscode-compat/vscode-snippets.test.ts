import { describe, expect, it } from 'vitest'
import {
  escapeNonPlaceholderDollars,
  parseVscodeSnippetFile,
  snippetHasTabStops,
  toSnippetCompletions
} from './vscode-snippets'

describe('parseVscodeSnippetFile', () => {
  it('parses a snippet with a string body', () => {
    const result = parseVscodeSnippetFile({
      'For Loop': { prefix: 'for', body: 'for i := 0; i < $1; i++ {\n\t$0\n}' }
    })
    expect(result.snippets).toEqual([
      {
        prefix: 'for',
        body: 'for i := 0; i < $1; i++ {\n\t$0\n}',
        name: 'For Loop',
        description: undefined,
        hasTabStops: true
      }
    ])
  })

  it('joins an array body with newlines, not commas', () => {
    const result = parseVscodeSnippetFile({
      Func: { prefix: 'fn', body: ['func $1() {', '\t$0', '}'] }
    })
    expect(result.snippets[0]!.body).toBe('func $1() {\n\t$0\n}')
  })

  it('emits one snippet per prefix when several are given', () => {
    const result = parseVscodeSnippetFile({
      Log: { prefix: ['log', 'clg'], body: 'console.log($1)' }
    })
    expect(result.snippets.map((snippet) => snippet.prefix)).toEqual(['log', 'clg'])
  })

  it('falls back to the snippet name when there is no prefix', () => {
    const result = parseVscodeSnippetFile({ iferr: { body: 'if err != nil {\n\t$0\n}' } })
    expect(result.snippets[0]!.prefix).toBe('iferr')
  })

  it('keeps the description', () => {
    const result = parseVscodeSnippetFile({
      A: { prefix: 'a', body: 'x', description: 'Inserts an x' }
    })
    expect(result.snippets[0]!.description).toBe('Inserts an x')
  })

  it('marks a body with no tab stops', () => {
    const result = parseVscodeSnippetFile({ A: { prefix: 'a', body: 'package main' } })
    expect(result.snippets[0]!.hasTabStops).toBe(false)
  })
})

describe('parseVscodeSnippetFile resilience', () => {
  it('skips a bad entry but keeps the rest of the file', () => {
    // A pack with one broken snippet should still contribute the others.
    const result = parseVscodeSnippetFile({
      Good: { prefix: 'g', body: 'ok' },
      NoBody: { prefix: 'n' },
      NotAnObject: 'nope',
      EmptyBody: { prefix: 'e', body: '' }
    })
    expect(result.snippets.map((snippet) => snippet.name)).toEqual(['Good'])
    expect(result.skipped.map((entry) => entry.name).sort()).toEqual([
      'EmptyBody',
      'NoBody',
      'NotAnObject'
    ])
  })

  it('reports the reason for each skip', () => {
    const result = parseVscodeSnippetFile({ NoBody: { prefix: 'n' } })
    expect(result.skipped[0]).toEqual({ name: 'NoBody', reason: 'no snippet body' })
  })

  it('reports a non-object file instead of throwing', () => {
    expect(parseVscodeSnippetFile('nope').skipped[0]).toMatchObject({ name: '(file)' })
    expect(parseVscodeSnippetFile(null).snippets).toEqual([])
    expect(parseVscodeSnippetFile([]).snippets).toEqual([])
  })

  it('caps a runaway snippet file', () => {
    const huge: Record<string, unknown> = {}
    for (let index = 0; index < 6_000; index += 1) {
      huge[`s${index}`] = { prefix: `p${index}`, body: 'x' }
    }
    const result = parseVscodeSnippetFile(huge)
    expect(result.snippets.length).toBeLessThanOrEqual(5_000)
    expect(result.skipped.at(-1)).toMatchObject({ name: '(remaining)' })
  })

  it('skips an oversized body', () => {
    const result = parseVscodeSnippetFile({
      Big: { prefix: 'b', body: 'x'.repeat(40_000) }
    })
    expect(result.snippets).toEqual([])
    expect(result.skipped[0]!.reason).toMatch(/too large/)
  })
})

describe('snippetHasTabStops', () => {
  it('detects the placeholder forms', () => {
    expect(snippetHasTabStops('a $1 b')).toBe(true)
    expect(snippetHasTabStops('a ${1} b')).toBe(true)
    expect(snippetHasTabStops('a ${1:name} b')).toBe(true)
    expect(snippetHasTabStops('a ${1|x,y|} b')).toBe(true)
    expect(snippetHasTabStops('a $0')).toBe(true)
  })

  it('does not mistake a shell variable for a tab stop', () => {
    expect(snippetHasTabStops('echo $PATH')).toBe(false)
    expect(snippetHasTabStops('echo ${HOME}')).toBe(false)
  })
})

describe('escapeNonPlaceholderDollars', () => {
  it('escapes a shell variable so the snippet inserts what it says', () => {
    // Unescaped, Monaco reads `$PATH` as a placeholder: the text vanishes and
    // the cursor jumps.
    expect(escapeNonPlaceholderDollars('echo $PATH')).toBe('echo \\$PATH')
  })

  it('escapes a PHP-style variable', () => {
    expect(escapeNonPlaceholderDollars('$var = $1;')).toBe('\\$var = $1;')
  })

  it('leaves real tab stops alone', () => {
    expect(escapeNonPlaceholderDollars('for ($1; $2; $3) { $0 }')).toBe(
      'for ($1; $2; $3) { $0 }'
    )
    expect(escapeNonPlaceholderDollars('${1:name}')).toBe('${1:name}')
  })

  it('leaves snippet variables Monaco resolves itself alone', () => {
    expect(escapeNonPlaceholderDollars('// $TM_FILENAME')).toBe('// $TM_FILENAME')
    expect(escapeNonPlaceholderDollars('${CURRENT_YEAR}')).toBe('${CURRENT_YEAR}')
    expect(escapeNonPlaceholderDollars('$CLIPBOARD')).toBe('$CLIPBOARD')
  })

  it('handles a body mixing all three', () => {
    expect(escapeNonPlaceholderDollars('echo "$USER" > $TM_FILENAME; read $1')).toBe(
      'echo "\\$USER" > $TM_FILENAME; read $1'
    )
  })
})

describe('toSnippetCompletions', () => {
  it('produces Monaco snippet completions', () => {
    const completions = toSnippetCompletions([
      { prefix: 'for', body: 'for $1 {}', name: 'For Loop', hasTabStops: true }
    ])
    expect(completions[0]).toMatchObject({
      label: 'for',
      kind: 27,
      insertText: 'for $1 {}',
      insertTextRules: 4,
      detail: 'For Loop'
    })
  })

  it('sorts snippets after real language completions', () => {
    // A snippet outranking an actual symbol is the usual complaint about
    // snippet packs, so the sort key pushes them down.
    expect(toSnippetCompletions([{ prefix: 'a', body: 'x', name: 'A', hasTabStops: false }])[0]!
      .sortText).toBe('zza')
  })

  it('handles an empty list', () => {
    expect(toSnippetCompletions([])).toEqual([])
  })
})
