import { describe, expect, it } from 'vitest'
import {
  createLspMessageDecoder,
  encodeLspMessage,
  type JsonRpcMessage
} from './lsp-message-framing'

const HELLO: JsonRpcMessage = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { a: 1 } }

function decodeAll(chunks: Buffer[]): ReturnType<ReturnType<typeof createLspMessageDecoder>['push']> {
  const decoder = createLspMessageDecoder()
  return chunks.flatMap((chunk) => decoder.push(chunk))
}

describe('encodeLspMessage', () => {
  it('measures Content-Length in bytes, not characters', () => {
    const encoded = encodeLspMessage({ jsonrpc: '2.0', method: 'log', params: { text: 'héllo—✓' } })
    const header = encoded.subarray(0, encoded.indexOf('\r\n\r\n')).toString('ascii')
    const declared = Number(/Content-Length: (\d+)/.exec(header)![1])
    const body = encoded.subarray(encoded.indexOf('\r\n\r\n') + 4)
    expect(body.byteLength).toBe(declared)
    expect(body.length).toBeGreaterThan(body.toString('utf8').length)
  })
})

describe('createLspMessageDecoder', () => {
  it('round-trips a message', () => {
    expect(decodeAll([encodeLspMessage(HELLO)])).toEqual([{ ok: true, message: HELLO }])
  })

  it('decodes several messages arriving in one chunk', () => {
    const chunk = Buffer.concat([encodeLspMessage(HELLO), encodeLspMessage(HELLO)])
    expect(decodeAll([chunk])).toHaveLength(2)
  })

  it('reassembles a message split mid-header and mid-body', () => {
    const encoded = encodeLspMessage(HELLO)
    const decoder = createLspMessageDecoder()
    const frames: ReturnType<typeof decoder.push> = []
    for (let index = 0; index < encoded.byteLength; index += 1) {
      frames.push(...decoder.push(encoded.subarray(index, index + 1)))
    }
    expect(frames).toEqual([{ ok: true, message: HELLO }])
    expect(decoder.pendingBytes()).toBe(0)
  })

  it('splits a multibyte character across chunks without corrupting it', () => {
    const message = { jsonrpc: '2.0' as const, method: 'log', params: { text: '→✓é' } }
    const encoded = encodeLspMessage(message)
    const frames = decodeAll([encoded.subarray(0, encoded.byteLength - 3), encoded.subarray(-3)])
    expect(frames).toEqual([{ ok: true, message }])
  })

  it('tolerates extra headers and header case', () => {
    const body = Buffer.from('{"jsonrpc":"2.0","method":"x"}', 'utf8')
    const framed = Buffer.concat([
      Buffer.from(
        `content-length: ${body.byteLength}\r\nContent-Type: application/vscode-jsonrpc\r\n\r\n`,
        'ascii'
      ),
      body
    ])
    expect(decodeAll([framed])).toEqual([{ ok: true, message: { jsonrpc: '2.0', method: 'x' } }])
  })

  it('reports a bad body without losing the next message', () => {
    const broken = Buffer.concat([Buffer.from('Content-Length: 3\r\n\r\n', 'ascii'), Buffer.from('{{{')])
    const frames = decodeAll([Buffer.concat([broken, encodeLspMessage(HELLO)])])
    expect(frames[0]).toEqual({ ok: false, error: 'message body is not valid JSON', fatal: false })
    expect(frames[1]).toEqual({ ok: true, message: HELLO })
  })

  it('poisons the stream when a server prints non-LSP output', () => {
    const frames = decodeAll([Buffer.alloc(9 * 1024, 0x61)])
    expect(frames).toEqual([
      { ok: false, error: 'no LSP header within 8KB of output', fatal: true }
    ])
  })

  it('refuses an absurd Content-Length instead of allocating for it', () => {
    const framed = Buffer.from('Content-Length: 99999999999\r\n\r\n', 'ascii')
    expect(decodeAll([framed])).toEqual([
      { ok: false, error: 'message claims 99999999999 bytes', fatal: true }
    ])
  })

  it('stops decoding after a fatal frame', () => {
    const decoder = createLspMessageDecoder()
    decoder.push(Buffer.from('Content-Length: bogus\r\n\r\n', 'ascii'))
    expect(decoder.push(encodeLspMessage(HELLO))).toEqual([])
  })
})
