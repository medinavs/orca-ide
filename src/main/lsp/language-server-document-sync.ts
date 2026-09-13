/**
 * Document synchronization payloads. Orca always has the whole buffer (Monaco
 * owns the model, not a diff stream), so the interesting part is meeting the
 * server's declared sync kind without pretending to track edits:
 *
 * - full sync takes the text as-is
 * - incremental sync takes one change whose range spans the *previous* text
 *
 * Replacing everything is a legal incremental change, and it is the only one a
 * client that did not observe the keystrokes can honestly send. Servers that
 * ask for incremental (gopls does) accept it; sending a bare `{ text }` to one
 * of those is the bug this module exists to prevent.
 */
import type { LspPosition, LspRange } from '../../shared/lsp/lsp-protocol-types'

export type LspContentChange = { text: string } | { range: LspRange; text: string }

/** End position of `text`, in UTF-16 code units, as LSP counts them. */
export function endPositionOf(text: string): LspPosition {
  let line = 0
  let lineStart = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      line += 1
      lineStart = index + 1
    }
  }
  return { line, character: text.length - lineStart }
}

export function buildContentChanges(
  syncKind: 0 | 1 | 2,
  previousText: string,
  nextText: string
): LspContentChange[] {
  if (syncKind === 0) {
    return []
  }
  if (syncKind === 1) {
    return [{ text: nextText }]
  }
  return [
    { range: { start: { line: 0, character: 0 }, end: endPositionOf(previousText) }, text: nextText }
  ]
}
