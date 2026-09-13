/**
 * The subset of LSP 3.17 Orca actually exchanges, declared here rather than
 * taken from `vscode-languageserver-protocol` so the wire surface Orca commits
 * to is visible and small. Anything a server sends beyond these fields is
 * carried through untouched — readers must tolerate extra keys.
 */

export type LspPosition = { line: number; character: number }
export type LspRange = { start: LspPosition; end: LspPosition }
export type LspLocation = { uri: string; range: LspRange }

/** `1` error, `2` warning, `3` information, `4` hint. */
export type LspDiagnosticSeverity = 1 | 2 | 3 | 4

export type LspDiagnostic = {
  range: LspRange
  severity?: LspDiagnosticSeverity
  code?: number | string
  source?: string
  message: string
  tags?: number[]
  relatedInformation?: { location: LspLocation; message: string }[]
}

export type LspPublishDiagnosticsParams = {
  uri: string
  version?: number
  diagnostics: LspDiagnostic[]
}

export type LspMarkupContent = { kind: 'plaintext' | 'markdown'; value: string }
export type LspHover = { contents: LspMarkupContent | string | (string | LspMarkupContent)[]; range?: LspRange }

export type LspTextEdit = { range: LspRange; newText: string }

export type LspCompletionItem = {
  label: string
  kind?: number
  detail?: string
  documentation?: string | LspMarkupContent
  sortText?: string
  filterText?: string
  insertText?: string
  /** `2` is snippet syntax; anything else is literal text. */
  insertTextFormat?: 1 | 2
  textEdit?: LspTextEdit | { range: LspRange; newText: string }
  additionalTextEdits?: LspTextEdit[]
  preselect?: boolean
  deprecated?: boolean
  data?: unknown
}

export type LspCompletionList = { isIncomplete: boolean; items: LspCompletionItem[] }

export type LspDocumentSymbol = {
  name: string
  detail?: string
  kind: number
  range: LspRange
  selectionRange: LspRange
  children?: LspDocumentSymbol[]
}

export type LspSymbolInformation = {
  name: string
  kind: number
  containerName?: string
  location: LspLocation
}

export type LspCodeAction = {
  title: string
  kind?: string
  diagnostics?: LspDiagnostic[]
  isPreferred?: boolean
  edit?: LspWorkspaceEdit
  command?: { title: string; command: string; arguments?: unknown[] }
}

export type LspWorkspaceEdit = {
  changes?: Record<string, LspTextEdit[]>
  documentChanges?: { textDocument: { uri: string; version?: number | null }; edits: LspTextEdit[] }[]
}

/** Only the fields Orca gates behaviour on; servers send far more. */
export type LspServerCapabilities = {
  textDocumentSync?: number | { change?: number; openClose?: boolean }
  hoverProvider?: boolean | object
  completionProvider?: { triggerCharacters?: string[]; resolveProvider?: boolean }
  definitionProvider?: boolean | object
  declarationProvider?: boolean | object
  typeDefinitionProvider?: boolean | object
  implementationProvider?: boolean | object
  referencesProvider?: boolean | object
  documentSymbolProvider?: boolean | object
  workspaceSymbolProvider?: boolean | object
  documentFormattingProvider?: boolean | object
  documentRangeFormattingProvider?: boolean | object
  codeActionProvider?: boolean | { codeActionKinds?: string[] }
  renameProvider?: boolean | object
  signatureHelpProvider?: { triggerCharacters?: string[] }
}

export type LspInitializeResult = {
  capabilities: LspServerCapabilities
  serverInfo?: { name: string; version?: string }
}

/** `0` none, `1` full, `2` incremental. */
export const LSP_TEXT_DOCUMENT_SYNC_KIND = { none: 0, full: 1, incremental: 2 } as const

export function textDocumentSyncKind(capabilities: LspServerCapabilities): 0 | 1 | 2 {
  const sync = capabilities.textDocumentSync
  if (typeof sync === 'number') {
    return sync === 2 ? 2 : sync === 1 ? 1 : 0
  }
  const change = sync?.change
  return change === 2 ? 2 : change === 1 ? 1 : 0
}

/** True when a capability is present and not explicitly `false`. */
export function supportsCapability(
  capabilities: LspServerCapabilities,
  key: keyof LspServerCapabilities
): boolean {
  const value = capabilities[key]
  return value !== undefined && value !== false && value !== null
}
