/**
 * LSP replies → the shapes Monaco's providers return.
 *
 * Pure and transport-free so each conversion is testable without an editor or
 * a server. The recurring hazards, all handled here:
 *
 * - positions are 0-based in LSP and 1-based in Monaco
 * - most requests may answer with a single item, an array, or null
 * - `insertText` defaults to the label, and snippet syntax is opt-in per item
 * - a server may answer for a file other than the one asked about
 */
import type { editor, languages } from 'monaco-editor'
import type {
  LspCodeAction,
  LspCompletionItem,
  LspCompletionList,
  LspDocumentSymbol,
  LspHover,
  LspLocation,
  LspMarkupContent,
  LspRange,
  LspSymbolInformation,
  LspTextEdit
} from '../../../../shared/lsp/lsp-protocol-types'
import { toMonacoRange, type MonacoRange } from './lsp-marker-conversion'
import { toMonacoCompletionKind, toMonacoSymbolKind } from './lsp-kind-conversion'

/** A `Location` after main annotated it with the host path. */
export type AnnotatedLocation = LspLocation & { path?: string }

function markupToString(
  contents: string | LspMarkupContent | (string | LspMarkupContent)[] | undefined
): string {
  if (contents === undefined) {
    return ''
  }
  if (typeof contents === 'string') {
    return contents
  }
  if (Array.isArray(contents)) {
    return contents.map((entry) => markupToString(entry)).filter(Boolean).join('\n\n')
  }
  return contents.value
}

export function toMonacoHover(hover: LspHover | null | undefined): languages.Hover | null {
  const value = markupToString(hover?.contents)
  if (value.trim() === '') {
    return null
  }
  return {
    contents: [{ value }],
    range: hover?.range === undefined ? undefined : toMonacoRange(hover.range)
  }
}

/** `null`, one item, or many — every location-ish request can answer all three. */
export function toLocationArray<T>(result: T | T[] | null | undefined): T[] {
  if (result === null || result === undefined) {
    return []
  }
  return Array.isArray(result) ? result : [result]
}

export type MonacoLocationLink = { uri: string; path?: string; range: MonacoRange }

export function toMonacoLocations(
  result: AnnotatedLocation | AnnotatedLocation[] | null | undefined
): MonacoLocationLink[] {
  return toLocationArray(result)
    .filter((location) => location !== null && typeof location.uri === 'string')
    .map((location) => ({
      uri: location.uri,
      path: location.path,
      range: toMonacoRange(location.range)
    }))
}

export function toMonacoTextEdits(
  edits: LspTextEdit[] | null | undefined
): languages.TextEdit[] {
  return (edits ?? []).map((edit) => ({
    range: toMonacoRange(edit.range) as unknown as languages.TextEdit['range'],
    text: edit.newText
  }))
}

/** LSP `insertTextFormat` 2 means snippet syntax; anything else is literal. */
function completionInsertRules(item: LspCompletionItem): number | undefined {
  // Monaco's `InsertAsSnippet` is 4.
  return item.insertTextFormat === 2 ? 4 : undefined
}

function completionRange(item: LspCompletionItem, fallback: LspRange): MonacoRange {
  const edit = item.textEdit
  if (edit && 'range' in edit) {
    return toMonacoRange(edit.range)
  }
  return toMonacoRange(fallback)
}

export type MonacoCompletionItem = {
  label: string
  kind: number
  detail?: string
  documentation?: string
  insertText: string
  insertTextRules?: number
  range: MonacoRange
  sortText?: string
  filterText?: string
  preselect?: boolean
  tags?: number[]
  additionalTextEdits?: languages.TextEdit[]
}

export function toMonacoCompletionItem(
  item: LspCompletionItem,
  fallbackRange: LspRange
): MonacoCompletionItem {
  const edit = item.textEdit
  return {
    label: item.label,
    kind: toMonacoCompletionKind(item.kind),
    detail: item.detail,
    documentation: markupToString(item.documentation) || undefined,
    // The label is the documented default when a server sends neither an
    // insertText nor a textEdit.
    insertText: (edit && 'newText' in edit ? edit.newText : item.insertText) ?? item.label,
    insertTextRules: completionInsertRules(item),
    range: completionRange(item, fallbackRange),
    sortText: item.sortText,
    filterText: item.filterText,
    preselect: item.preselect,
    // Monaco's only completion tag is `Deprecated` = 1.
    tags: item.deprecated === true ? [1] : undefined,
    additionalTextEdits:
      item.additionalTextEdits === undefined
        ? undefined
        : toMonacoTextEdits(item.additionalTextEdits)
  }
}

export function toMonacoCompletionList(
  result: LspCompletionList | LspCompletionItem[] | null | undefined,
  fallbackRange: LspRange
): { suggestions: MonacoCompletionItem[]; incomplete: boolean } {
  if (result === null || result === undefined) {
    return { suggestions: [], incomplete: false }
  }
  const items = Array.isArray(result) ? result : result.items
  const incomplete = Array.isArray(result) ? false : result.isIncomplete === true
  return {
    suggestions: (items ?? []).map((item) => toMonacoCompletionItem(item, fallbackRange)),
    incomplete
  }
}

export type MonacoDocumentSymbol = {
  name: string
  detail: string
  kind: number
  range: MonacoRange
  selectionRange: MonacoRange
  tags: never[]
  children?: MonacoDocumentSymbol[]
}

function isDocumentSymbol(
  symbol: LspDocumentSymbol | LspSymbolInformation
): symbol is LspDocumentSymbol {
  return 'selectionRange' in symbol
}

/**
 * Servers answer `documentSymbol` with either the hierarchical
 * `DocumentSymbol[]` or the flat, legacy `SymbolInformation[]`. Both are legal,
 * so both are accepted; the flat form becomes a single level.
 */
export function toMonacoDocumentSymbols(
  result: (LspDocumentSymbol | LspSymbolInformation)[] | null | undefined
): MonacoDocumentSymbol[] {
  return (result ?? []).map((symbol) => {
    if (isDocumentSymbol(symbol)) {
      return {
        name: symbol.name,
        detail: symbol.detail ?? '',
        kind: toMonacoSymbolKind(symbol.kind),
        range: toMonacoRange(symbol.range),
        selectionRange: toMonacoRange(symbol.selectionRange),
        tags: [],
        children:
          symbol.children === undefined ? undefined : toMonacoDocumentSymbols(symbol.children)
      }
    }
    const range = toMonacoRange(symbol.location.range)
    return {
      name: symbol.name,
      detail: symbol.containerName ?? '',
      kind: toMonacoSymbolKind(symbol.kind),
      range,
      selectionRange: range,
      tags: []
    }
  })
}

export type MonacoCodeAction = {
  title: string
  kind?: string
  isPreferred?: boolean
  /** Present only when the action carries a workspace edit Orca can apply. */
  edit?: { edits: { resource: string; textEdit: languages.TextEdit }[] }
  /** Set when the action's only effect is a server command Orca does not run. */
  unsupportedCommand?: string
}

/**
 * Code actions, restricted to the ones Orca can actually carry out.
 *
 * An action whose effect is a `command` is reported with
 * `unsupportedCommand` rather than offered as a working fix:
 * `workspace/executeCommand` is deliberately not forwardable, so offering it
 * would put a quick-fix in the lightbulb that silently does nothing.
 */
export function toMonacoCodeActions(
  result: (LspCodeAction | { title: string; command?: string })[] | null | undefined
): MonacoCodeAction[] {
  return (result ?? []).map((entry) => {
    const action = entry as LspCodeAction
    const changes = action.edit?.changes
    const documentChanges = action.edit?.documentChanges
    const edits: { resource: string; textEdit: languages.TextEdit }[] = []
    for (const [uri, textEdits] of Object.entries(changes ?? {})) {
      for (const textEdit of toMonacoTextEdits(textEdits)) {
        edits.push({ resource: uri, textEdit })
      }
    }
    for (const change of documentChanges ?? []) {
      for (const textEdit of toMonacoTextEdits(change.edits)) {
        edits.push({ resource: change.textDocument.uri, textEdit })
      }
    }
    return {
      title: action.title,
      kind: action.kind,
      isPreferred: action.isPreferred,
      edit: edits.length > 0 ? { edits } : undefined,
      unsupportedCommand:
        edits.length === 0 && action.command !== undefined ? action.command.command : undefined
    }
  })
}

/** Monaco's `editor.IIdentifiedSingleEditOperation`, for applying formatting. */
export function toEditOperations(edits: LspTextEdit[]): editor.IIdentifiedSingleEditOperation[] {
  return edits.map((edit) => ({
    range: toMonacoRange(edit.range) as unknown as editor.IIdentifiedSingleEditOperation['range'],
    text: edit.newText
  }))
}
