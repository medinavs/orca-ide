/**
 * Path ↔ `file://` URI translation at the main-process boundary.
 *
 * The renderer never sees a URI. It cannot build one correctly anyway — that
 * needs `node:url` and the host's path rules (Windows drive letters, UNC
 * shares, percent-encoding), none of which belong in a sandboxed renderer
 * that may not even be on the same machine as the files.
 *
 * So: requests get their `textDocument.uri` filled in here from the document
 * ref, and every `uri` a server sends back gains a sibling `path` the
 * renderer can act on directly.
 */
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Depth cap: server replies are shallow, and a cycle must not hang main. */
const MAX_WALK_DEPTH = 12

/**
 * Fills in `textDocument.uri` for the methods that take one.
 *
 * `workspace/symbol` and `completionItem/resolve` address no document, so they
 * are passed through untouched rather than given a misleading uri.
 */
export function withDocumentUri(
  method: string,
  params: unknown,
  path: string
): unknown {
  if (!method.startsWith('textDocument/')) {
    return params
  }
  const uri = pathToFileURL(path).href
  const base = typeof params === 'object' && params !== null ? params : {}
  const existing = (base as { textDocument?: Record<string, unknown> }).textDocument
  return {
    ...base,
    textDocument: { ...existing, uri }
  }
}

function pathForUri(uri: string): string | null {
  if (!uri.startsWith('file:')) {
    return null
  }
  try {
    return fileURLToPath(uri)
  } catch {
    return null
  }
}

/**
 * Annotates every `{ uri }` in a server reply with its host `path`.
 *
 * A generic walk rather than one branch per reply shape: `Location`,
 * `LocationLink`, `DocumentSymbol` related info and `WorkspaceEdit`
 * `documentChanges` all nest a uri at a different depth, and each new feature
 * would otherwise add another case that is easy to forget.
 *
 * Non-file URIs keep their `uri` and get no `path` — a server may point at a
 * generated or virtual document the renderer cannot open.
 */
export function annotateUriPaths<T>(value: T, depth = 0): T {
  if (depth > MAX_WALK_DEPTH || value === null || typeof value !== 'object') {
    return value
  }
  if (Array.isArray(value)) {
    return value.map((entry) => annotateUriPaths(entry, depth + 1)) as unknown as T
  }
  const record = value as Record<string, unknown>
  const annotated: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(record)) {
    annotated[key] = annotateUriPaths(entry, depth + 1)
  }
  if (typeof record.uri === 'string' && annotated.path === undefined) {
    const path = pathForUri(record.uri)
    if (path !== null) {
      annotated.path = path
    }
  }
  return annotated as T
}
