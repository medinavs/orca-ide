/**
 * LSP kind enums → Monaco kind enums.
 *
 * Both sides number their kinds independently and neither ordering is
 * guessable, so the tables are written out and pinned by tests. Getting one
 * wrong shows up as the wrong icon beside a completion, which is the kind of
 * bug nobody files and everybody notices.
 */

/** LSP `CompletionItemKind` (1–25) → Monaco `CompletionItemKind`. */
const COMPLETION_KIND: Record<number, number> = {
  1: 18, // Text
  2: 0, // Method
  3: 1, // Function
  4: 2, // Constructor
  5: 3, // Field
  6: 4, // Variable
  7: 5, // Class
  8: 7, // Interface
  9: 8, // Module
  10: 9, // Property
  11: 12, // Unit
  12: 13, // Value
  13: 15, // Enum
  14: 17, // Keyword
  15: 27, // Snippet
  16: 19, // Color
  17: 20, // File
  18: 21, // Reference
  19: 23, // Folder
  20: 16, // EnumMember
  21: 14, // Constant
  22: 6, // Struct
  23: 10, // Event
  24: 11, // Operator
  25: 24 // TypeParameter
}

/** Monaco's `Text` kind — the least misleading icon for an unknown kind. */
const COMPLETION_KIND_FALLBACK = 18

export function toMonacoCompletionKind(kind: number | undefined): number {
  return kind === undefined ? COMPLETION_KIND_FALLBACK : (COMPLETION_KIND[kind] ?? COMPLETION_KIND_FALLBACK)
}

/**
 * LSP `SymbolKind` (1–26) → Monaco `SymbolKind` (0–25).
 *
 * The two happen to be offset by exactly one across the whole range, which is
 * why this is arithmetic rather than a table — but it is asserted in a test,
 * because "they line up" is a fact about two external enums, not a guarantee.
 */
export function toMonacoSymbolKind(kind: number | undefined): number {
  if (kind === undefined || kind < 1 || kind > 26) {
    // Monaco's `File`, the neutral choice for something unrecognised.
    return 0
  }
  return kind - 1
}

/** Monaco marker tag `1` is Unnecessary, `2` Deprecated — same as LSP's. */
export function toMonacoDiagnosticTags(tags: number[] | undefined): number[] | undefined {
  return tags
}
