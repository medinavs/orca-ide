import { describe, expect, it } from 'vitest'
import { adaptVscodeLanguageConfiguration } from './vscode-language-configuration'

describe('adaptVscodeLanguageConfiguration comments', () => {
  it('maps line and block comments', () => {
    const { configuration } = adaptVscodeLanguageConfiguration({
      comments: { lineComment: '//', blockComment: ['/*', '*/'] }
    })
    expect(configuration.comments).toEqual({
      lineComment: '//',
      blockComment: ['/*', '*/']
    })
  })

  it('keeps a line comment with no block comment', () => {
    const { configuration } = adaptVscodeLanguageConfiguration({
      comments: { lineComment: '#' }
    })
    expect(configuration.comments).toEqual({ lineComment: '#' })
  })

  it('drops a malformed block comment', () => {
    const { configuration } = adaptVscodeLanguageConfiguration({
      comments: { blockComment: ['/*'] }
    })
    expect(configuration.comments?.blockComment).toBeUndefined()
  })
})

describe('adaptVscodeLanguageConfiguration brackets and pairs', () => {
  it('converts bracket tuples, which Monaco wants as tuples', () => {
    const { configuration } = adaptVscodeLanguageConfiguration({
      brackets: [
        ['{', '}'],
        ['[', ']']
      ]
    })
    expect(configuration.brackets).toEqual([
      ['{', '}'],
      ['[', ']']
    ])
  })

  it('accepts the object form of a bracket entry', () => {
    const { configuration } = adaptVscodeLanguageConfiguration({
      brackets: [{ open: '(', close: ')' }]
    })
    expect(configuration.brackets).toEqual([['(', ')']])
  })

  it('converts auto-closing pairs as objects and keeps notIn', () => {
    const { configuration } = adaptVscodeLanguageConfiguration({
      autoClosingPairs: [
        { open: '"', close: '"', notIn: ['string'] },
        ['{', '}']
      ]
    })
    expect(configuration.autoClosingPairs).toEqual([
      { open: '"', close: '"', notIn: ['string'] },
      { open: '{', close: '}' }
    ])
  })

  it('converts surrounding pairs', () => {
    const { configuration } = adaptVscodeLanguageConfiguration({
      surroundingPairs: [['`', '`']]
    })
    expect(configuration.surroundingPairs).toEqual([{ open: '`', close: '`' }])
  })

  it('skips malformed pair entries without losing the good ones', () => {
    const { configuration } = adaptVscodeLanguageConfiguration({
      brackets: [['{', '}'], ['only-one'], null, { open: '(' }]
    })
    expect(configuration.brackets).toEqual([['{', '}']])
  })

  it('omits empty collections rather than sending empty arrays', () => {
    const { configuration } = adaptVscodeLanguageConfiguration({ brackets: [] })
    expect(configuration.brackets).toBeUndefined()
  })
})

describe('adaptVscodeLanguageConfiguration patterns', () => {
  it('compiles a string wordPattern', () => {
    const { configuration } = adaptVscodeLanguageConfiguration({ wordPattern: '[A-Za-z_]+' })
    expect(configuration.wordPattern?.test('hello')).toBe(true)
  })

  it('compiles the object form with flags', () => {
    const { configuration } = adaptVscodeLanguageConfiguration({
      wordPattern: { pattern: 'abc', flags: 'i' }
    })
    expect(configuration.wordPattern?.flags).toContain('i')
    expect(configuration.wordPattern?.test('ABC')).toBe(true)
  })

  it('reports an uncompilable pattern instead of throwing', () => {
    // An extension's bad regex must not take down language registration.
    const result = adaptVscodeLanguageConfiguration({ wordPattern: '([unclosed' })
    expect(result.configuration.wordPattern).toBeUndefined()
    expect(result.invalidPatterns).toEqual(['wordPattern'])
  })

  it('rejects an absurdly long pattern', () => {
    const result = adaptVscodeLanguageConfiguration({ wordPattern: 'a'.repeat(2000) })
    expect(result.invalidPatterns).toEqual(['wordPattern'])
  })

  it('keeps folding markers only when both sides compile', () => {
    const both = adaptVscodeLanguageConfiguration({
      folding: { offSide: true, markers: { start: '^//#region', end: '^//#endregion' } }
    })
    // Asserted by matching, not by `source`: JS escapes forward slashes there.
    expect(both.configuration.folding?.markers?.start.test('//#region setup')).toBe(true)
    expect(both.configuration.folding?.markers?.end.test('//#endregion')).toBe(true)
    expect(both.configuration.folding?.offSide).toBe(true)

    // One marker alone folds nothing, so it is dropped.
    const one = adaptVscodeLanguageConfiguration({
      folding: { markers: { start: '^//#region' } }
    })
    expect(one.configuration.folding?.markers).toBeUndefined()
  })

  it('keeps indentation rules only when both required patterns compile', () => {
    const complete = adaptVscodeLanguageConfiguration({
      indentationRules: {
        increaseIndentPattern: '\\{$',
        decreaseIndentPattern: '^\\}',
        indentNextLinePattern: '=>$'
      }
    })
    expect(complete.configuration.indentationRules?.increaseIndentPattern.source).toBe('\\{$')
    expect(complete.configuration.indentationRules?.indentNextLinePattern?.source).toBe('=>$')

    const partial = adaptVscodeLanguageConfiguration({
      indentationRules: { increaseIndentPattern: '\\{$' }
    })
    expect(partial.configuration.indentationRules).toBeUndefined()
  })

  it('names every invalid pattern it found', () => {
    const result = adaptVscodeLanguageConfiguration({
      wordPattern: '([',
      folding: { markers: { start: '([', end: '([' } }
    })
    expect(result.invalidPatterns).toEqual([
      'wordPattern',
      'folding.markers.start',
      'folding.markers.end'
    ])
  })
})

describe('adaptVscodeLanguageConfiguration resilience', () => {
  it('returns an empty configuration for a non-object file', () => {
    const result = adaptVscodeLanguageConfiguration('nope')
    expect(result.configuration).toEqual({})
    expect(result.invalidPatterns).toEqual(['(file is not a JSON object)'])
  })

  it('returns an empty configuration for an empty object', () => {
    expect(adaptVscodeLanguageConfiguration({})).toEqual({
      configuration: {},
      invalidPatterns: []
    })
  })

  it('carries autoCloseBefore through', () => {
    const { configuration } = adaptVscodeLanguageConfiguration({ autoCloseBefore: ';:.,=}])' })
    expect(configuration.autoCloseBefore).toBe(';:.,=}])')
  })

  it('ignores onEnterRules, which Orca does not apply', () => {
    const { configuration } = adaptVscodeLanguageConfiguration({
      onEnterRules: [{ beforeText: 'x' }],
      comments: { lineComment: '//' }
    })
    expect(configuration).not.toHaveProperty('onEnterRules')
    expect(configuration.comments?.lineComment).toBe('//')
  })
})
