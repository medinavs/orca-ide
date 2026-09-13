/**
 * Builds real ZIP archives for the `.vsix` reader tests.
 *
 * A hand-built archive rather than a checked-in binary: the tests need to vary
 * the bytes (stored vs deflate, unsafe names, truncated data, a declared size
 * that lies), and a fixture file cannot be varied. Written with Node's own
 * `deflateRawSync`, so the reader is exercised against genuine deflate output
 * rather than something this file also invented.
 */
import { crc32 } from 'node:zlib'
import { deflateRawSync } from 'node:zlib'

export type ZipInput = {
  path: string
  contents: Buffer | string
  /** `0` stored, `8` deflate. Default deflate. */
  method?: 0 | 8
  /** Overrides the uncompressed size written to the headers, to fake a bomb. */
  declaredUncompressedSize?: number
  /** Sets the "encrypted" general-purpose flag. */
  encrypted?: boolean
}

function checksum(data: Buffer): number {
  // `node:zlib.crc32` exists on Node 20.15+/22+; this repo's floor is above it.
  return crc32(data)
}

export function buildZip(inputs: readonly ZipInput[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const input of inputs) {
    const raw = Buffer.isBuffer(input.contents) ? input.contents : Buffer.from(input.contents)
    const method = input.method ?? 8
    const compressed = method === 0 ? raw : deflateRawSync(raw)
    const nameBytes = Buffer.from(input.path, 'utf8')
    const flags = input.encrypted === true ? 0x1 : 0
    const declaredSize = input.declaredUncompressedSize ?? raw.length

    const local = Buffer.alloc(30 + nameBytes.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(checksum(raw), 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(declaredSize, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    nameBytes.copy(local, 30)
    locals.push(local, compressed)

    const central = Buffer.alloc(46 + nameBytes.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(checksum(raw), 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(declaredSize, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    nameBytes.copy(central, 46)
    centrals.push(central)

    offset += local.length + compressed.length
  }

  const localBlock = Buffer.concat(locals)
  const centralBlock = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(inputs.length, 8)
  end.writeUInt16LE(inputs.length, 10)
  end.writeUInt32LE(centralBlock.length, 12)
  end.writeUInt32LE(localBlock.length, 16)
  return Buffer.concat([localBlock, centralBlock, end])
}

/** A `.vsix` whose files sit under the `extension/` prefix VS Code uses. */
export function buildVsix(
  manifest: unknown,
  extras: readonly ZipInput[] = []
): Buffer {
  return buildZip([
    { path: 'extension.vsixmanifest', contents: '<PackageManifest />' },
    { path: 'extension/package.json', contents: JSON.stringify(manifest) },
    ...extras.map((extra) => ({ ...extra, path: `extension/${extra.path}` }))
  ])
}
