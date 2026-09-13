/**
 * The language-feature requests the editor may issue, and the server
 * capability each one needs.
 *
 * An allowlist rather than a passthrough: one IPC channel serving every
 * feature is the small design, but letting the renderer name any method would
 * hand a compromised renderer the whole server API (including
 * `workspace/executeCommand`, which runs server-defined commands). The table
 * costs a line per feature and closes that.
 *
 * The capability column is the other half: asking a server for a feature it
 * never advertised earns a `methodNotFound` rejection, which the editor would
 * surface as a broken feature rather than an absent one. Unsupported returns
 * null, so Monaco simply shows nothing.
 */
import {
  supportsCapability,
  type LspServerCapabilities
} from '../../shared/lsp/lsp-protocol-types'

export type LanguageFeatureMethod =
  | 'textDocument/hover'
  | 'textDocument/completion'
  | 'completionItem/resolve'
  | 'textDocument/definition'
  | 'textDocument/declaration'
  | 'textDocument/typeDefinition'
  | 'textDocument/implementation'
  | 'textDocument/references'
  | 'textDocument/documentSymbol'
  | 'textDocument/formatting'
  | 'textDocument/rangeFormatting'
  | 'textDocument/codeAction'
  | 'textDocument/signatureHelp'
  | 'workspace/symbol'

/** Capability gating each method; null means "always allowed to try". */
const REQUIRED_CAPABILITY: Record<
  LanguageFeatureMethod,
  keyof LspServerCapabilities | null
> = {
  'textDocument/hover': 'hoverProvider',
  'textDocument/completion': 'completionProvider',
  // Resolve is gated by a nested flag, checked separately below.
  'completionItem/resolve': 'completionProvider',
  'textDocument/definition': 'definitionProvider',
  'textDocument/declaration': 'declarationProvider',
  'textDocument/typeDefinition': 'typeDefinitionProvider',
  'textDocument/implementation': 'implementationProvider',
  'textDocument/references': 'referencesProvider',
  'textDocument/documentSymbol': 'documentSymbolProvider',
  'textDocument/formatting': 'documentFormattingProvider',
  'textDocument/rangeFormatting': 'documentRangeFormattingProvider',
  'textDocument/codeAction': 'codeActionProvider',
  'textDocument/signatureHelp': 'signatureHelpProvider',
  'workspace/symbol': 'workspaceSymbolProvider'
}

export const LANGUAGE_FEATURE_METHODS = Object.keys(
  REQUIRED_CAPABILITY
) as LanguageFeatureMethod[]

export function isLanguageFeatureMethod(method: string): method is LanguageFeatureMethod {
  return Object.hasOwn(REQUIRED_CAPABILITY, method)
}

export function serverSupportsFeature(
  capabilities: LspServerCapabilities | undefined,
  method: LanguageFeatureMethod
): boolean {
  if (capabilities === undefined) {
    return false
  }
  if (method === 'completionItem/resolve') {
    const provider = capabilities.completionProvider
    return typeof provider === 'object' && provider.resolveProvider === true
  }
  const required = REQUIRED_CAPABILITY[method]
  return required === null || supportsCapability(capabilities, required)
}
