/**
 * Reading files out of an untrusted extension directory, safely.
 *
 * The security primitive for the whole VS Code compatibility layer, in one
 * place. The manifest schema already rejects `../` inside a declared path, but
 * textual validation is not containment: a **symlink** inside the extension
 * pointing at `~/.ssh/id_rsa` is a perfectly ordinary-looking relative path
 * that still escapes. So containment is decided on the *real* path, after
 * symlink resolution, never on the joined one.
 */
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'

/** A theme, grammar or snippet file larger than this is not legitimate. */
export const MAX_CONTRIBUTION_FILE_BYTES = 8 * 1024 * 1024

export type ContainedPathResult =
  | { ok: true; realPath: string }
  | { ok: false; error: string }

export type ContainedPathOptions = {
  /**
   * Symlink resolver. Injectable because unprivileged Windows cannot create a
   * symlink, so a test that needs a real one skips — and this is the one
   * decision in the compatibility layer that must never go untested.
   */
  realpath?: (path: string) => string
  /** Path separator of the host being checked; defaults to this one. */
  separator?: string
}

export function resolveContainedPath(
  root: string,
  relativePath: string,
  options: ContainedPathOptions = {}
): ContainedPathResult {
  if (isAbsolute(relativePath)) {
    return { ok: false, error: 'path must be relative to the extension directory' }
  }
  const realpath = options.realpath ?? realpathSync
  const separator = options.separator ?? sep
  const target = resolve(join(root, relativePath))
  let realRoot: string
  let realTarget: string
  try {
    realRoot = realpath(root)
    realTarget = realpath(target)
  } catch {
    return { ok: false, error: 'file not found' }
  }
  // The trailing separator matters: without it, root `/ext` would contain
  // `/ext-evil`, because one string is a prefix of the other.
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + separator)) {
    return { ok: false, error: 'path escapes the extension directory' }
  }
  return { ok: true, realPath: realTarget }
}

export type ContainedReadResult = { ok: true; contents: string } | { ok: false; error: string }

export function readContainedFile(
  root: string,
  relativePath: string,
  maxBytes = MAX_CONTRIBUTION_FILE_BYTES
): ContainedReadResult {
  const resolved = resolveContainedPath(root, relativePath)
  if (!resolved.ok) {
    return resolved
  }
  try {
    const stats = statSync(resolved.realPath)
    if (!stats.isFile()) {
      return { ok: false, error: 'path is not a file' }
    }
    if (stats.size > maxBytes) {
      return { ok: false, error: `file exceeds ${maxBytes} bytes` }
    }
    return { ok: true, contents: readFileSync(resolved.realPath, 'utf8') }
  } catch {
    return { ok: false, error: 'file could not be read' }
  }
}

/**
 * Confirms a contained file exists without reading it — for grammars, whose
 * bodies are read lazily by the tokenizer when their language is first opened.
 */
export function containedFileExists(
  root: string,
  relativePath: string
): { ok: true; realPath: string } | { ok: false; error: string } {
  const resolved = resolveContainedPath(root, relativePath)
  if (!resolved.ok) {
    return resolved
  }
  try {
    return statSync(resolved.realPath).isFile()
      ? resolved
      : { ok: false, error: 'path is not a file' }
  } catch {
    return { ok: false, error: 'file could not be read' }
  }
}
