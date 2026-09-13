/**
 * Minimal ZIP reader for `.vsix` files.
 *
 * A `.vsix` is a ZIP. Node has no ZIP reader, and rather than take a
 * dependency this mirrors what `skill-package-tar.ts` already does for skill
 * bundles: read the container format directly, decompress with `node:zlib`,
 * and cap everything. The threat model is identical — an archive downloaded
 * from the internet — so the same three defences apply:
 *
 * - **zip-slip**: entry names are validated and re-checked after joining, so
 *   `../../.ssh/authorized_keys` never becomes a write path
 * - **zip bombs**: both the compressed archive and each expanded entry are
 *   capped, so a 1MB file cannot expand to fill the disk
 * - **malformed headers**: every offset is bounds-checked before it is read
 *
 * Only what a `.vsix` actually uses is implemented: stored (0) and deflate (8)
 * entries, read through the central directory. Encrypted entries, ZIP64 and
 * multi-disk archives are refused rather than guessed at.
 */
import { inflateRawSync } from 'node:zlib'

export const VSIX_MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
export const VSIX_MAX_ENTRY_BYTES = 64 * 1024 * 1024
export const VSIX_MAX_ENTRIES = 20_000

const END_OF_CENTRAL_DIRECTORY = 0x06054b50
const CENTRAL_FILE_HEADER = 0x02014b50
const LOCAL_FILE_HEADER = 0x04034b50
const ZIP64_END_LOCATOR = 0x07064b50

export type ZipEntry = {
  /** Normalized, forward-slashed, validated as safe to join onto a root. */
  path: string
  compressedSize: number
  uncompressedSize: number
  compressionMethod: number
  localHeaderOffset: number
  isDirectory: boolean
}

export type ZipReadResult<T> = { ok: true; value: T } | { ok: false; error: string }

/**
 * Rejects any entry name that could escape the extraction root.
 *
 * Checked on the name itself — absolute paths, drive letters, UNC prefixes,
 * `..` segments — because the joined path is only re-checked afterwards, and a
 * defence that runs only after the join is one refactor away from being lost.
 */
export function isSafeZipEntryPath(name: string): boolean {
  if (name === '' || name.length > 1024) {
    return false
  }
  const normalized = name.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.startsWith('//')) {
    return false
  }
  const segments = normalized.split('/')
  return !segments.some(
    (segment) =>
      segment === '..' ||
      // A NUL in a name truncates the path for some syscalls.
      segment.includes('\0')
  )
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  // The record is at the end but may be followed by a comment of up to 64KB.
  const earliest = Math.max(0, buffer.length - 0xffff - 22)
  for (let offset = buffer.length - 22; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) {
      return offset
    }
  }
  return -1
}

export function readZipCentralDirectory(buffer: Buffer): ZipReadResult<ZipEntry[]> {
  if (buffer.length > VSIX_MAX_ARCHIVE_BYTES) {
    return { ok: false, error: 'archive is too large' }
  }
  if (buffer.length < 22) {
    return { ok: false, error: 'file is too small to be a .vsix archive' }
  }
  const endOffset = findEndOfCentralDirectory(buffer)
  if (endOffset < 0) {
    return { ok: false, error: 'not a valid .vsix archive (no ZIP directory found)' }
  }
  if (endOffset >= 20 && buffer.readUInt32LE(endOffset - 20) === ZIP64_END_LOCATOR) {
    return { ok: false, error: 'ZIP64 archives are not supported' }
  }

  const entryCount = buffer.readUInt16LE(endOffset + 10)
  const directorySize = buffer.readUInt32LE(endOffset + 12)
  const directoryOffset = buffer.readUInt32LE(endOffset + 16)
  if (entryCount > VSIX_MAX_ENTRIES) {
    return { ok: false, error: `archive declares more than ${VSIX_MAX_ENTRIES} entries` }
  }
  if (directoryOffset + directorySize > buffer.length) {
    return { ok: false, error: 'archive directory is truncated' }
  }

  const entries: ZipEntry[] = []
  let cursor = directoryOffset
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_FILE_HEADER) {
      return { ok: false, error: 'archive directory is malformed' }
    }
    const flags = buffer.readUInt16LE(cursor + 8)
    if ((flags & 0x1) !== 0) {
      return { ok: false, error: 'encrypted .vsix archives are not supported' }
    }
    const compressionMethod = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42)
    const nameStart = cursor + 46
    if (nameStart + nameLength > buffer.length) {
      return { ok: false, error: 'archive directory is truncated' }
    }
    const rawName = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8')
    const path = rawName.replace(/\\/g, '/')
    const isDirectory = path.endsWith('/')
    if (!isDirectory && !isSafeZipEntryPath(path)) {
      return { ok: false, error: `archive contains an unsafe path: ${rawName}` }
    }
    if (uncompressedSize > VSIX_MAX_ENTRY_BYTES) {
      return { ok: false, error: `archive entry "${path}" is too large` }
    }
    entries.push({
      path,
      compressedSize,
      uncompressedSize,
      compressionMethod,
      localHeaderOffset,
      isDirectory
    })
    cursor = nameStart + nameLength + extraLength + commentLength
  }
  return { ok: true, value: entries }
}

/** Reads and decompresses one entry's bytes. */
export function readZipEntry(buffer: Buffer, entry: ZipEntry): ZipReadResult<Buffer> {
  if (entry.isDirectory) {
    return { ok: false, error: 'entry is a directory' }
  }
  const header = entry.localHeaderOffset
  if (header + 30 > buffer.length || buffer.readUInt32LE(header) !== LOCAL_FILE_HEADER) {
    return { ok: false, error: `entry "${entry.path}" has a malformed local header` }
  }
  // The local header repeats the name and extra lengths, and they may differ
  // from the central directory's; the local ones locate the data.
  const nameLength = buffer.readUInt16LE(header + 26)
  const extraLength = buffer.readUInt16LE(header + 28)
  const dataStart = header + 30 + nameLength + extraLength
  const dataEnd = dataStart + entry.compressedSize
  if (dataEnd > buffer.length) {
    return { ok: false, error: `entry "${entry.path}" is truncated` }
  }
  const data = buffer.subarray(dataStart, dataEnd)

  if (entry.compressionMethod === 0) {
    return { ok: true, value: Buffer.from(data) }
  }
  if (entry.compressionMethod !== 8) {
    return {
      ok: false,
      error: `entry "${entry.path}" uses unsupported compression method ${entry.compressionMethod}`
    }
  }
  try {
    // `maxOutputLength` makes zlib itself refuse a bomb, rather than trusting
    // the size the archive declares about itself.
    const inflated = inflateRawSync(data, { maxOutputLength: VSIX_MAX_ENTRY_BYTES })
    return { ok: true, value: inflated }
  } catch {
    return { ok: false, error: `entry "${entry.path}" could not be decompressed` }
  }
}

export function findZipEntry(entries: readonly ZipEntry[], path: string): ZipEntry | null {
  const wanted = path.toLowerCase()
  return entries.find((entry) => entry.path.toLowerCase() === wanted) ?? null
}
