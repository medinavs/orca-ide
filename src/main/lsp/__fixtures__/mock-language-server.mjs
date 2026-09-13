#!/usr/bin/env node
/**
 * A minimal, real LSP server over stdio, used to test the session end to end
 * without depending on gopls being installed.
 *
 * Behaviour is steered by env vars so one fixture covers several shapes:
 *   MOCK_LSP_SYNC_KIND    — textDocumentSync kind to advertise (default 2)
 *   MOCK_LSP_NO_HANDSHAKE — never answer `initialize`
 *   MOCK_LSP_GARBAGE      — print non-LSP output on stdout and stay up
 *   MOCK_LSP_CRASH_ON     — exit(3) when this method arrives
 *   MOCK_LSP_IGNORE_EXIT  — do not exit on `exit`, forcing a kill
 *   MOCK_LSP_ASK_CONFIG   — request workspace/configuration during startup
 */
import process from 'node:process'

const syncKind = Number(process.env.MOCK_LSP_SYNC_KIND ?? '2')
const crashOn = process.env.MOCK_LSP_CRASH_ON ?? ''

/** Everything the session observed, echoed back on request for assertions. */
const received = []
let nextId = 1000

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  process.stdout.write(`Content-Length: ${body.byteLength}\r\n\r\n`)
  process.stdout.write(body)
}

function handle(message) {
  received.push({ method: message.method, params: message.params })
  if (crashOn !== '' && message.method === crashOn) {
    process.exit(3)
  }
  switch (message.method) {
    case 'initialize':
      if (process.env.MOCK_LSP_NO_HANDSHAKE) {
        return
      }
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          capabilities: {
            textDocumentSync: { change: syncKind, openClose: true },
            hoverProvider: true,
            completionProvider: { triggerCharacters: ['.'] },
            definitionProvider: true,
            referencesProvider: true,
            documentSymbolProvider: true,
            documentFormattingProvider: true
          },
          serverInfo: { name: 'mock-lsp', version: '1.2.3' }
        }
      })
      return
    case 'initialized':
      if (process.env.MOCK_LSP_ASK_CONFIG) {
        send({
          jsonrpc: '2.0',
          id: nextId++,
          method: 'workspace/configuration',
          params: { items: [{ section: 'mock' }] }
        })
      }
      return
    case 'textDocument/didOpen':
      send({
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: {
          uri: message.params.textDocument.uri,
          version: message.params.textDocument.version,
          diagnostics: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
              severity: 1,
              message: 'mock error',
              source: 'mock-lsp'
            }
          ]
        }
      })
      return
    case 'textDocument/hover':
      send({ jsonrpc: '2.0', id: message.id, result: { contents: { kind: 'markdown', value: 'hi' } } })
      return
    case '$/mockReceived':
      send({ jsonrpc: '2.0', id: message.id, result: received })
      return
    case 'shutdown':
      send({ jsonrpc: '2.0', id: message.id, result: null })
      return
    case 'exit':
      if (!process.env.MOCK_LSP_IGNORE_EXIT) {
        process.exit(0)
      }
      return
    default:
      if (message.id !== undefined) {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not implemented' } })
      }
  }
}

if (process.env.MOCK_LSP_GARBAGE) {
  process.stdout.write('panic: runtime error: invalid memory address\n'.repeat(400))
}

let buffered = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
  buffered = Buffer.concat([buffered, chunk])
  for (;;) {
    const headerEnd = buffered.indexOf('\r\n\r\n')
    if (headerEnd === -1) {
      return
    }
    const header = buffered.subarray(0, headerEnd).toString('ascii')
    const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1] ?? '-1')
    const bodyStart = headerEnd + 4
    if (length < 0 || buffered.byteLength - bodyStart < length) {
      return
    }
    const body = buffered.subarray(bodyStart, bodyStart + length).toString('utf8')
    buffered = buffered.subarray(bodyStart + length)
    handle(JSON.parse(body))
  }
})
// Keep the process alive until told otherwise.
process.stdin.resume()
