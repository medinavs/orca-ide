import { describe, expect, it, vi } from 'vitest'
import {
  createLspConnection,
  LspConnectionClosedError,
  LspRequestError,
  LSP_ERROR_CODES,
  type LspConnection
} from './lsp-connection'
import {
  createLspMessageDecoder,
  encodeLspMessage,
  type JsonRpcMessage
} from './lsp-message-framing'

/** A loopback the test drives as if it were the language server. */
function createHarness(): {
  connection: LspConnection
  sent: JsonRpcMessage[]
  reply: (message: JsonRpcMessage) => void
  protocolErrors: { error: string; fatal: boolean }[]
} {
  const decoder = createLspMessageDecoder()
  const sent: JsonRpcMessage[] = []
  const protocolErrors: { error: string; fatal: boolean }[] = []
  const connection = createLspConnection({
    transport: {
      write: (data) => {
        for (const frame of decoder.push(data)) {
          if (frame.ok) {
            sent.push(frame.message)
          }
        }
      }
    },
    onProtocolError: (error, fatal) => protocolErrors.push({ error, fatal })
  })
  return {
    connection,
    sent,
    protocolErrors,
    reply: (message) => connection.handleData(encodeLspMessage(message))
  }
}

describe('createLspConnection', () => {
  it('correlates a response to its request', async () => {
    const { connection, sent, reply } = createHarness()
    const pending = connection.request('textDocument/hover', { line: 1 })
    expect(sent[0]).toMatchObject({ jsonrpc: '2.0', id: 1, method: 'textDocument/hover' })
    reply({ jsonrpc: '2.0', id: 1, result: { contents: 'docs' } })
    await expect(pending).resolves.toEqual({ contents: 'docs' })
    expect(connection.pendingRequestCount()).toBe(0)
  })

  it('resolves concurrent requests to the right caller when answered out of order', async () => {
    const { connection, sent, reply } = createHarness()
    const first = connection.request('a')
    const second = connection.request('b')
    reply({ jsonrpc: '2.0', id: (sent[1] as { id: number }).id, result: 'second' })
    reply({ jsonrpc: '2.0', id: (sent[0] as { id: number }).id, result: 'first' })
    await expect(first).resolves.toBe('first')
    await expect(second).resolves.toBe('second')
  })

  it('rejects with the server error code and method context', async () => {
    const { connection, reply } = createHarness()
    const pending = connection.request('textDocument/definition')
    reply({
      jsonrpc: '2.0',
      id: 1,
      error: { code: LSP_ERROR_CODES.contentModified, message: 'stale' }
    })
    await expect(pending).rejects.toThrow(LspRequestError)
    await expect(pending).rejects.toThrow(/textDocument\/definition: stale/)
  })

  it('delivers notifications to a subscriber and stops after unsubscribe', () => {
    const { connection, reply } = createHarness()
    const handler = vi.fn()
    const unsubscribe = connection.onNotification('textDocument/publishDiagnostics', handler)
    reply({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'file:///a' } })
    expect(handler).toHaveBeenCalledWith({ uri: 'file:///a' })
    unsubscribe()
    reply({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'file:///b' } })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('answers a server-to-client request from its handler', async () => {
    const { connection, sent, reply } = createHarness()
    connection.onRequest('workspace/configuration', () => [{ analyses: {} }])
    reply({ jsonrpc: '2.0', id: 7, method: 'workspace/configuration', params: { items: [] } })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]).toEqual({ jsonrpc: '2.0', id: 7, result: [{ analyses: {} }] })
  })

  it('answers methodNotFound rather than leaving the server waiting', async () => {
    const { sent, reply } = createHarness()
    reply({ jsonrpc: '2.0', id: 7, method: 'client/registerCapability' })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]).toMatchObject({ id: 7, error: { code: LSP_ERROR_CODES.methodNotFound } })
  })

  it('reports a throwing request handler as a JSON-RPC error', async () => {
    const { connection, sent, reply } = createHarness()
    connection.onRequest('window/showMessageRequest', () => {
      throw new LspRequestError(LSP_ERROR_CODES.invalidRequest, 'nope')
    })
    reply({ jsonrpc: '2.0', id: 3, method: 'window/showMessageRequest' })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]).toMatchObject({ id: 3, error: { code: LSP_ERROR_CODES.invalidRequest } })
  })

  it('cancels an aborted request and tells the server', async () => {
    const { connection, sent } = createHarness()
    const controller = new AbortController()
    const pending = connection.request('textDocument/completion', {}, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: LSP_ERROR_CODES.requestCancelled })
    expect(sent[1]).toEqual({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 1 } })
    expect(connection.pendingRequestCount()).toBe(0)
  })

  it('drops a late reply to a cancelled request', async () => {
    const { connection, reply } = createHarness()
    const controller = new AbortController()
    const pending = connection.request('textDocument/completion', {}, controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow()
    expect(() => reply({ jsonrpc: '2.0', id: 1, result: 'late' })).not.toThrow()
  })

  it('rejects everything in flight when the connection closes', async () => {
    const { connection } = createHarness()
    const pending = connection.request('textDocument/hover')
    connection.close('server exited')
    await expect(pending).rejects.toThrow(LspConnectionClosedError)
    await expect(connection.request('textDocument/hover')).rejects.toThrow(LspConnectionClosedError)
  })

  it('closes on a fatal framing fault and reports a recoverable one', () => {
    const { connection, protocolErrors } = createHarness()
    connection.handleData(
      Buffer.concat([Buffer.from('Content-Length: 2\r\n\r\n', 'ascii'), Buffer.from('{{')])
    )
    expect(protocolErrors).toEqual([
      { error: 'message body is not valid JSON', fatal: false }
    ])
    connection.handleData(Buffer.alloc(9 * 1024, 0x61))
    expect(protocolErrors[1]?.fatal).toBe(true)
    expect(() => connection.notify('exit')).not.toThrow()
  })

  it('ignores a response for an id it never issued', () => {
    const { connection } = createHarness()
    expect(() => connection.handleData(
      encodeLspMessage({ jsonrpc: '2.0', id: 999, result: 'orphan' })
    )).not.toThrow()
  })
})
