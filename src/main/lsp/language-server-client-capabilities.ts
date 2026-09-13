/**
 * What Orca tells a language server it can do. Declared narrowly and in one
 * place: a server tailors its replies to this, so announcing a capability Orca
 * does not actually honour (a snippet it pastes literally, a partial result it
 * drops) shows up as a wrong answer in the editor rather than as an error.
 */

export const ORCA_LSP_CLIENT_CAPABILITIES = {
  general: {
    // UTF-16 is what Monaco counts in, so take it first and never assume it.
    positionEncodings: ['utf-16']
  },
  workspace: {
    workspaceFolders: true,
    configuration: true,
    symbol: { symbolKind: { valueSet: Array.from({ length: 26 }, (_, index) => index + 1) } },
    didChangeConfiguration: { dynamicRegistration: false }
  },
  textDocument: {
    synchronization: { dynamicRegistration: false, willSave: false, didSave: true },
    publishDiagnostics: { relatedInformation: true, versionSupport: true },
    hover: { contentFormat: ['markdown', 'plaintext'] },
    completion: {
      completionItem: {
        snippetSupport: true,
        documentationFormat: ['markdown', 'plaintext'],
        insertReplaceSupport: false,
        resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] }
      },
      contextSupport: true
    },
    definition: { linkSupport: false },
    declaration: { linkSupport: false },
    typeDefinition: { linkSupport: false },
    implementation: { linkSupport: false },
    references: {},
    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
    formatting: {},
    rangeFormatting: {},
    codeAction: {
      codeActionLiteralSupport: {
        codeActionKind: {
          valueSet: ['quickfix', 'refactor', 'source', 'source.organizeImports', 'source.fixAll']
        }
      },
      isPreferredSupport: true
    },
    rename: { prepareSupport: false },
    signatureHelp: { signatureInformation: { documentationFormat: ['markdown', 'plaintext'] } }
  },
  window: {
    // Progress is accepted so servers that gate indexing on it proceed; Orca
    // reports it as a status line rather than a progress bar.
    workDoneProgress: true
  }
} as const
