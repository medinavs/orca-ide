/**
 * Installing a `.vsix`: extract to a staging directory, read it as an
 * extension, then hand it to the store.
 *
 * Staged first, then validated, then moved — so a malformed or incompatible
 * archive never leaves a half-installed extension behind for the loader to
 * trip over on the next launch.
 *
 * A `.vsix` nests everything under `extension/`, which is stripped during
 * extraction so the staged directory looks like any other extension folder
 * and the same reader handles both.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import {
  findZipEntry,
  readZipCentralDirectory,
  readZipEntry,
  VSIX_MAX_ARCHIVE_BYTES,
  type ZipEntry
} from './vsix-archive'
import type { InstalledVscodeExtension, VscodeExtensionStore } from './vscode-extension-store'

/** VS Code packages the extension under this prefix inside the archive. */
const VSIX_EXTENSION_PREFIX = 'extension/'

export type VsixInstallResult =
  | { ok: true; extension: InstalledVscodeExtension }
  | { ok: false; error: string }

function stripPrefix(path: string): string | null {
  if (path.toLowerCase().startsWith(VSIX_EXTENSION_PREFIX)) {
    return path.slice(VSIX_EXTENSION_PREFIX.length)
  }
  // `extension.vsixmanifest`, `[Content_Types].xml` and anything else outside
  // the `extension/` folder is packaging metadata Orca does not need.
  return null
}

export type VsixExtractResult = { ok: true; root: string } | { ok: false; error: string }

/**
 * Extracts the `extension/` subtree of a `.vsix` into `destination`.
 *
 * Every write path is re-checked against the destination after joining. The
 * entry names were already validated, but re-checking here is what makes the
 * guarantee hold if either side is ever changed independently.
 */
export function extractVsix(archive: Buffer, destination: string): VsixExtractResult {
  const directory = readZipCentralDirectory(archive)
  if (!directory.ok) {
    return { ok: false, error: directory.error }
  }
  const manifestEntry =
    findZipEntry(directory.value, 'extension/package.json') ??
    findZipEntry(directory.value, 'package.json')
  if (manifestEntry === null) {
    return { ok: false, error: 'the .vsix contains no extension/package.json' }
  }

  const realDestination = resolve(destination)
  let written = 0
  for (const entry of directory.value) {
    if (entry.isDirectory) {
      continue
    }
    const relative = stripPrefix(entry.path)
    if (relative === null || relative === '') {
      continue
    }
    const target = resolve(join(realDestination, relative))
    if (target !== realDestination && !target.startsWith(realDestination + sep)) {
      return { ok: false, error: `the .vsix contains an unsafe path: ${entry.path}` }
    }
    const contents = readZipEntry(archive, entry)
    if (!contents.ok) {
      return { ok: false, error: contents.error }
    }
    try {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, contents.value)
      written += 1
    } catch (error) {
      return { ok: false, error: `could not write ${relative}: ${String(error)}` }
    }
  }
  if (written === 0) {
    return { ok: false, error: 'the .vsix contained no extension files' }
  }
  return { ok: true, root: realDestination }
}

export type VsixInstallOptions = {
  store: VscodeExtensionStore
  /** Override for tests; defaults to the OS temp directory. */
  stagingRoot?: string
}

export function installVsixFile(
  archivePath: string,
  options: VsixInstallOptions
): VsixInstallResult {
  let archive: Buffer
  try {
    const stats = statSync(archivePath)
    if (!stats.isFile()) {
      return { ok: false, error: 'not a file' }
    }
    if (stats.size > VSIX_MAX_ARCHIVE_BYTES) {
      return { ok: false, error: 'the .vsix is too large' }
    }
    archive = readFileSync(archivePath)
  } catch {
    return { ok: false, error: 'the .vsix could not be read' }
  }

  const stagingParent = options.stagingRoot ?? tmpdir()
  mkdirSync(stagingParent, { recursive: true })
  const staging = mkdtempSync(join(stagingParent, 'orca-vsix-staging-'))
  try {
    const extracted = extractVsix(archive, staging)
    if (!extracted.ok) {
      return { ok: false, error: extracted.error }
    }
    // The store re-reads and re-validates from the staged copy, so a `.vsix`
    // and a plain directory install go through exactly the same checks.
    return options.store.installFromDirectory(extracted.root)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

export type { ZipEntry }
