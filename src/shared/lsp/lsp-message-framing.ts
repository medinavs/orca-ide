/**
 * LSP base-protocol framing: `Content-Length: <bytes>\r\n\r\n<utf8 json>`.
 *
 * Hand-rolled rather than taking `vscode-jsonrpc`: the codec is the only part
 * of that package Orca needs, and a language server is untrusted input, so the
 * byte caps below have to be ours anyway.
 */

export type JsonRpcId = number | string

export type JsonRpcRequest = { jsonrpc: '2.0'; id: JsonRpcId; method: string; params?: unknown }
export type JsonRpcNotification = { jsonrpc: '2.0'; method: string; params?: unknown }
export type JsonRpcError = { code: number; message: string; data?: unknown }
export type JsonRpcResponse = {
  jsonrpc: '2.0'
  id: JsonRpcId | null
  result?: unknown
  error?: JsonRpcError
}
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

/** A server that announces more than this is malfunctioning, not verbose. */
export const LSP_MAX_CONTENT_LENGTH = 64 * 1024 * 1024
/** Headers are three short lines at most; anything longer is not LSP. */
const MAX_HEADER_BYTES = 8 * 1024
const HEADER_TERMINATOR = '\r\n\r\n'

export function encodeLspMessage(message: JsonRpcMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  return Buffer.concat([Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, 'ascii'), body])
}

export type LspFrame =
  | { ok: true; message: JsonRpcMessage }
  /** Framing or JSON failure. Fatal ones set `fatal` — the stream is unrecoverable. */
  | { ok: false; error: string; fatal: boolean }

export type LspMessageDecoder = {
  /** Decodes every whole frame now available; partial tails stay buffered. */
  push(chunk: Buffer): LspFrame[]
  /** Bytes held pending more input — for leak assertions. */
  pendingBytes(): number
}

export function createLspMessageDecoder(): LspMessageDecoder {
  let buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let poisoned = false

  function readContentLength(header: string): number | null {
    for (const line of header.split('\r\n')) {
      const separator = line.indexOf(':')
      if (separator === -1) {
        continue
      }
      if (line.slice(0, separator).trim().toLowerCase() !== 'content-length') {
        continue
      }
      const value = Number(line.slice(separator + 1).trim())
      return Number.isSafeInteger(value) && value >= 0 ? value : null
    }
    return null
  }

  return {
    push(chunk) {
      if (poisoned) {
        return []
      }
      buffered = buffered.byteLength === 0 ? chunk : Buffer.concat([buffered, chunk])
      const frames: LspFrame[] = []
      for (;;) {
        const headerEnd = buffered.indexOf(HEADER_TERMINATOR)
        if (headerEnd === -1) {
          // Why: without this the decoder would buffer an entire non-LSP stdout
          // stream (a server printing a stack trace) waiting for a terminator.
          if (buffered.byteLength > MAX_HEADER_BYTES) {
            poisoned = true
            buffered = Buffer.alloc(0)
            frames.push({ ok: false, error: 'no LSP header within 8KB of output', fatal: true })
          }
          return frames
        }
        const header = buffered.subarray(0, headerEnd).toString('ascii')
        const contentLength = readContentLength(header)
        if (contentLength === null) {
          poisoned = true
          buffered = Buffer.alloc(0)
          frames.push({ ok: false, error: 'header has no usable Content-Length', fatal: true })
          return frames
        }
        if (contentLength > LSP_MAX_CONTENT_LENGTH) {
          poisoned = true
          buffered = Buffer.alloc(0)
          frames.push({ ok: false, error: `message claims ${contentLength} bytes`, fatal: true })
          return frames
        }
        const bodyStart = headerEnd + HEADER_TERMINATOR.length
        if (buffered.byteLength - bodyStart < contentLength) {
          return frames
        }
        const body = buffered.subarray(bodyStart, bodyStart + contentLength).toString('utf8')
        buffered = buffered.subarray(bodyStart + contentLength)
        try {
          const parsed: unknown = JSON.parse(body)
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            // A batch or scalar is legal JSON-RPC but never sent by an LSP server.
            frames.push({ ok: false, error: 'message body is not a JSON object', fatal: false })
            continue
          }
          frames.push({ ok: true, message: parsed as JsonRpcMessage })
        } catch {
          frames.push({ ok: false, error: 'message body is not valid JSON', fatal: false })
        }
      }
    },
    pendingBytes: () => buffered.byteLength
  }
}
