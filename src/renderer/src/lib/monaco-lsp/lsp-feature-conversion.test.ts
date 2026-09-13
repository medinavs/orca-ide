import { describe, expect, it } from 'vitest'
import {
  toEditOperations,
  toLocationArray,
  toMonacoCodeActions,
  toMonacoCompletionItem,
  toMonacoCompletionList,
  toMonacoDocumentSymbols,
  toMonacoHover,
  toMonacoLocations,
  toMonacoTextEdits
} from './lsp-feature-conversion'
import { toMonacoCompletionKind, toMonacoSymbolKind } from './lsp-kind-conversion'

const RANGE = { start: { line: 4, character: 2 }, end: { line: 4, character: 8 } }

describe('toMonacoHover', () => {
  it('renders markup content', () => {
    expect(toMonacoHover({ contents: { kind: 'markdown', value: '**Greet**' } })).toEqual({
      contents: [{ value: '**Greet**' }],
      range: undefined
    })
  })

  it('accepts a bare string, which older servers still send', () => {
    expect(toMonacoHover({ contents: 'plain' })?.contents).toEqual([{ value: 'plain' }])
  })

  it('joins the legacy array form', () => {
    const hover = toMonacoHover({
      contents: ['first', { kind: 'plaintext', value: 'second' }]
    })
    expect(hover?.contents).toEqual([{ value: 'first\n\nsecond' }])
  })

  it('converts the range to 1-based when present', () => {
    expect(toMonacoHover({ contents: 'x', range: RANGE })?.range).toMatchObject({
      startLineNumber: 5,
      startColumn: 3
    })
  })

  it('returns null for empty or missing content, so no empty tooltip shows', () => {
    expect(toMonacoHover(null)).toBeNull()
    expect(toMonacoHover(undefined)).toBeNull()
    expect(toMonacoHover({ contents: '   ' })).toBeNull()
    expect(toMonacoHover({ contents: [] })).toBeNull()
  })
})

describe('toLocationArray', () => {
  it('normalizes the three legal answer shapes', () => {
    expect(toLocationArray(null)).toEqual([])
    expect(toLocationArray(undefined)).toEqual([])
    expect(toLocationArray({ a: 1 })).toEqual([{ a: 1 }])
    expect(toLocationArray([{ a: 1 }, { a: 2 }])).toHaveLength(2)
  })
})

describe('toMonacoLocations', () => {
  it('converts a single location and keeps the host path main annotated', () => {
    expect(
      toMonacoLocations({ uri: 'file:///repo/main.go', path: '/repo/main.go', range: RANGE })
    ).toEqual([
      {
        uri: 'file:///repo/main.go',
        path: '/repo/main.go',
        range: { startLineNumber: 5, startColumn: 3, endLineNumber: 5, endColumn: 9 }
      }
    ])
  })

  it('drops a malformed entry rather than producing a broken link', () => {
    expect(
      toMonacoLocations([
        { uri: 'file:///a', range: RANGE },
        { range: RANGE } as unknown as { uri: string; range: typeof RANGE }
      ])
    ).toHaveLength(1)
  })

  it('returns an empty list for no answer', () => {
    expect(toMonacoLocations(null)).toEqual([])
  })
})

describe('toMonacoCompletionItem', () => {
  it('defaults insertText to the label', () => {
    // The documented default; without it a server that sends neither
    // insertText nor textEdit would insert nothing.
    expect(toMonacoCompletionItem({ label: 'Println' }, RANGE).insertText).toBe('Println')
  })

  it('prefers a textEdit newText over insertText', () => {
    const item = toMonacoCompletionItem(
      {
        label: 'Println',
        insertText: 'ignored',
        textEdit: { range: RANGE, newText: 'Println($0)' }
      },
      RANGE
    )
    expect(item.insertText).toBe('Println($0)')
  })

  it('marks snippet syntax only when the server asked for it', () => {
    expect(
      toMonacoCompletionItem({ label: 'x', insertText: 'x($0)', insertTextFormat: 2 }, RANGE)
        .insertTextRules
    ).toBe(4)
    expect(
      toMonacoCompletionItem({ label: 'x', insertText: 'x($0)', insertTextFormat: 1 }, RANGE)
        .insertTextRules
    ).toBeUndefined()
    // Absent means literal text: treating it as a snippet would make `$0`
    // and `}` in ordinary completions behave as placeholders.
    expect(
      toMonacoCompletionItem({ label: 'x', insertText: 'cost: $0' }, RANGE).insertTextRules
    ).toBeUndefined()
  })

  it('uses the textEdit range when given, else the fallback', () => {
    const withEdit = toMonacoCompletionItem(
      { label: 'x', textEdit: { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'x' } },
      RANGE
    )
    expect(withEdit.range).toMatchObject({ startLineNumber: 1, endColumn: 2 })
    expect(toMonacoCompletionItem({ label: 'x' }, RANGE).range).toMatchObject({
      startLineNumber: 5,
      startColumn: 3
    })
  })

  it('flattens documentation markup to a string', () => {
    expect(
      toMonacoCompletionItem(
        { label: 'x', documentation: { kind: 'markdown', value: 'docs' } },
        RANGE
      ).documentation
    ).toBe('docs')
  })

  it('tags a deprecated item', () => {
    expect(toMonacoCompletionItem({ label: 'x', deprecated: true }, RANGE).tags).toEqual([1])
    expect(toMonacoCompletionItem({ label: 'x' }, RANGE).tags).toBeUndefined()
  })

  it('converts additional edits, which is how auto-import works', () => {
    const item = toMonacoCompletionItem(
      { label: 'Println', additionalTextEdits: [{ range: RANGE, newText: 'import "fmt"\n' }] },
      RANGE
    )
    expect(item.additionalTextEdits).toEqual([
      { range: expect.objectContaining({ startLineNumber: 5 }), text: 'import "fmt"\n' }
    ])
  })
})

describe('toMonacoCompletionList', () => {
  it('accepts a CompletionList', () => {
    const list = toMonacoCompletionList(
      { isIncomplete: true, items: [{ label: 'a' }, { label: 'b' }] },
      RANGE
    )
    expect(list.suggestions).toHaveLength(2)
    expect(list.incomplete).toBe(true)
  })

  it('accepts the bare-array form', () => {
    const list = toMonacoCompletionList([{ label: 'a' }], RANGE)
    expect(list.suggestions).toHaveLength(1)
    expect(list.incomplete).toBe(false)
  })

  it('is empty for no answer', () => {
    expect(toMonacoCompletionList(null, RANGE)).toEqual({ suggestions: [], incomplete: false })
  })
})

describe('toMonacoDocumentSymbols', () => {
  it('converts the hierarchical form, including children', () => {
    const symbols = toMonacoDocumentSymbols([
      {
        name: 'Service',
        kind: 5,
        range: RANGE,
        selectionRange: RANGE,
        children: [{ name: 'Handle', kind: 6, range: RANGE, selectionRange: RANGE }]
      }
    ])
    expect(symbols[0]).toMatchObject({ name: 'Service', kind: 4 })
    expect(symbols[0]!.children?.[0]).toMatchObject({ name: 'Handle', kind: 5 })
  })

  it('accepts the flat legacy SymbolInformation form', () => {
    const symbols = toMonacoDocumentSymbols([
      { name: 'Greet', kind: 12, containerName: 'main', location: { uri: 'file:///a', range: RANGE } }
    ])
    expect(symbols[0]).toMatchObject({ name: 'Greet', detail: 'main', kind: 11 })
    expect(symbols[0]!.selectionRange).toEqual(symbols[0]!.range)
  })

  it('is empty for no answer', () => {
    expect(toMonacoDocumentSymbols(null)).toEqual([])
  })
})

describe('toMonacoCodeActions', () => {
  it('converts a workspace edit keyed by uri', () => {
    const actions = toMonacoCodeActions([
      {
        title: 'Organize imports',
        kind: 'source.organizeImports',
        edit: { changes: { 'file:///repo/main.go': [{ range: RANGE, newText: '' }] } }
      }
    ])
    expect(actions[0]!.edit?.edits).toEqual([
      { resource: 'file:///repo/main.go', textEdit: expect.objectContaining({ text: '' }) }
    ])
    expect(actions[0]!.unsupportedCommand).toBeUndefined()
  })

  it('converts the documentChanges form too', () => {
    const actions = toMonacoCodeActions([
      {
        title: 'Fix',
        edit: {
          documentChanges: [
            {
              textDocument: { uri: 'file:///repo/a.go', version: 2 },
              edits: [{ range: RANGE, newText: 'x' }]
            }
          ]
        }
      }
    ])
    expect(actions[0]!.edit?.edits[0]!.resource).toBe('file:///repo/a.go')
  })

  it('flags a command-only action instead of offering a fix that does nothing', () => {
    // `workspace/executeCommand` is not forwardable, so surfacing this as a
    // working quick-fix would put a dead lightbulb entry in the editor.
    const actions = toMonacoCodeActions([
      { title: 'Run go mod tidy', command: { title: 'tidy', command: 'gopls.tidy' } }
    ])
    expect(actions[0]).toMatchObject({
      title: 'Run go mod tidy',
      unsupportedCommand: 'gopls.tidy'
    })
    expect(actions[0]!.edit).toBeUndefined()
  })

  it('is empty for no answer', () => {
    expect(toMonacoCodeActions(null)).toEqual([])
  })
})

describe('edit conversions', () => {
  it('converts formatting edits to 1-based ranges', () => {
    expect(toMonacoTextEdits([{ range: RANGE, newText: 'x' }])).toEqual([
      { range: expect.objectContaining({ startLineNumber: 5, startColumn: 3 }), text: 'x' }
    ])
  })

  it('builds edit operations for a model apply', () => {
    expect(toEditOperations([{ range: RANGE, newText: 'y' }])).toEqual([
      { range: expect.objectContaining({ startLineNumber: 5 }), text: 'y' }
    ])
  })

  it('handles no edits', () => {
    expect(toMonacoTextEdits(null)).toEqual([])
    expect(toEditOperations([])).toEqual([])
  })
})

describe('kind conversions', () => {
  it('maps every LSP completion kind to a distinct Monaco kind', () => {
    const mapped = Array.from({ length: 25 }, (_, index) => toMonacoCompletionKind(index + 1))
    expect(new Set(mapped).size).toBe(25)
  })

  it('maps the named completion kinds correctly', () => {
    expect(toMonacoCompletionKind(3)).toBe(1) // Function
    expect(toMonacoCompletionKind(15)).toBe(27) // Snippet
    expect(toMonacoCompletionKind(7)).toBe(5) // Class
  })

  it('falls back to Text for an unknown or missing completion kind', () => {
    expect(toMonacoCompletionKind(undefined)).toBe(18)
    expect(toMonacoCompletionKind(999)).toBe(18)
  })

  it('offsets symbol kinds by exactly one across the whole range', () => {
    // Asserted rather than assumed: this is a fact about two external enums.
    for (let kind = 1; kind <= 26; kind += 1) {
      expect(toMonacoSymbolKind(kind)).toBe(kind - 1)
    }
  })

  it('falls back to File for an out-of-range symbol kind', () => {
    expect(toMonacoSymbolKind(0)).toBe(0)
    expect(toMonacoSymbolKind(27)).toBe(0)
    expect(toMonacoSymbolKind(undefined)).toBe(0)
  })
})
