/**
 * JSON-RPC 2.0 over the LSP base protocol, transport-agnostic: the caller owns
 * the bytes (a child process's stdio, a relay stream, a test pipe) and this
 * owns correlation, cancellation and teardown.
 *
 * Server-to-client requests are answered even when unhandled — a server that
 * calls `workspace/configuration` and never gets a reply stalls its own
 * initialization, so silence is not a safe default.
 */
import {
  createLspMessageDecoder,
  encodeLspMessage,
  type JsonRpcError,
  type JsonRpcId,
  type JsonRpcMessage
} from './lsp-message-framing'

/** JSON-RPC reserved codes plus the two LSP adds. */
export const LSP_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  internalError: -32603,
  serverNotInitialized: -32002,
  requestCancelled: -32800,
  contentModified: -32801
} as const

export class LspRequestError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message)
    this.name = 'LspRequestError'
  }
}

/** Rejection for every in-flight request when the connection goes away. */
export class LspConnectionClosedError extends Error {
  constructor(reason: string) {
    super(`language server connection closed: ${reason}`)
    this.name = 'LspConnectionClosedError'
  }
}

export type LspTransport = {
  write(data: Buffer): void
}

export type LspConnectionOptions = {
  transport: LspTransport
  /** Framing/protocol faults. A fatal one closes the connection. */
  onProtocolError?: (error: string, fatal: boolean) => void
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  method: string
  disposeAbort?: () => void
}

export type LspConnection = {
  /** Feed bytes read from the server. */
  handleData(chunk: Buffer): void
  request<T = unknown>(method: string, params?: unknown, signal?: AbortSignal): Promise<T>
  notify(method: string, params?: unknown): void
  /** Last registration wins; returns an unsubscribe. */
  onNotification(method: string, handler: (params: unknown) => void): () => void
  /** Handlers may return a promise, and may throw `LspRequestError` to answer
   *  with a JSON-RPC error. */
  onRequest(method: string, handler: (params: unknown) => unknown): () => void
  close(reason: string): void
  pendingRequestCount(): number
}

export function createLspConnection(options: LspConnectionOptions): LspConnection {
  const decoder = createLspMessageDecoder()
  const pending = new Map<JsonRpcId, PendingRequest>()
  const notificationHandlers = new Map<string, (params: unknown) => void>()
  const requestHandlers = new Map<string, (params: unknown) => unknown>()
  let nextId = 1
  let closed: string | null = null

  function send(message: JsonRpcMessage): void {
    if (closed !== null) {
      return
    }
    options.transport.write(encodeLspMessage(message))
  }

  function close(reason: string): void {
    if (closed !== null) {
      return
    }
    closed = reason
    const inFlight = [...pending.values()]
    pending.clear()
    for (const entry of inFlight) {
      entry.disposeAbort?.()
      entry.reject(new LspConnectionClosedError(reason))
    }
  }

  function settle(id: JsonRpcId, result: unknown, error: JsonRpcError | undefined): void {
    const entry = pending.get(id)
    if (!entry) {
      return
    }
    pending.delete(id)
    entry.disposeAbort?.()
    if (error) {
      entry.reject(new LspRequestError(error.code, `${entry.method}: ${error.message}`, error.data))
      return
    }
    entry.resolve(result)
  }

  async function answerRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    const handler = requestHandlers.get(method)
    if (!handler) {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: LSP_ERROR_CODES.methodNotFound, message: `unhandled request ${method}` }
      })
      return
    }
    try {
      send({ jsonrpc: '2.0', id, result: (await handler(params)) ?? null })
    } catch (error) {
      const failure =
        error instanceof LspRequestError
          ? { code: error.code, message: error.message, data: error.data }
          : { code: LSP_ERROR_CODES.internalError, message: String(error) }
      send({ jsonrpc: '2.0', id, error: failure })
    }
  }

  function dispatch(message: JsonRpcMessage): void {
    const record = message as Record<string, unknown>
    const hasId = 'id' in record && record.id !== null
    if (typeof record.method === 'string') {
      if (hasId) {
        void answerRequest(record.id as JsonRpcId, record.method, record.params)
        return
      }
      notificationHandlers.get(record.method)?.(record.params)
      return
    }
    if (hasId) {
      settle(record.id as JsonRpcId, record.result, record.error as JsonRpcError | undefined)
    }
  }

  return {
    handleData(chunk) {
      for (const frame of decoder.push(chunk)) {
        if (frame.ok) {
          dispatch(frame.message)
          continue
        }
        options.onProtocolError?.(frame.error, frame.fatal)
        if (frame.fatal) {
          close(frame.error)
          return
        }
      }
    },

    request<T>(method, params, signal) {
      if (closed !== null) {
        return Promise.reject(new LspConnectionClosedError(closed))
      }
      if (signal?.aborted === true) {
        return Promise.reject(new LspRequestError(LSP_ERROR_CODES.requestCancelled, method))
      }
      const id = nextId++
      return new Promise<T>((resolve, reject) => {
        const entry: PendingRequest = {
          resolve: resolve as (value: unknown) => void,
          reject,
          method
        }
        if (signal) {
          const onAbort = (): void => {
            if (!pending.delete(id)) {
              return
            }
            // Why: `$/cancelRequest` is advisory — the server may still answer,
            // so the id stays consumed and the late reply is dropped above.
            send({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } })
            reject(new LspRequestError(LSP_ERROR_CODES.requestCancelled, method))
          }
          signal.addEventListener('abort', onAbort, { once: true })
          entry.disposeAbort = () => signal.removeEventListener('abort', onAbort)
        }
        pending.set(id, entry)
        send({ jsonrpc: '2.0', id, method, params })
      })
    },

    notify(method, params) {
      send({ jsonrpc: '2.0', method, params })
    },

    onNotification(method, handler) {
      notificationHandlers.set(method, handler)
      return () => {
        if (notificationHandlers.get(method) === handler) {
          notificationHandlers.delete(method)
        }
      }
    },

    onRequest(method, handler) {
      requestHandlers.set(method, handler)
      return () => {
        if (requestHandlers.get(method) === handler) {
          requestHandlers.delete(method)
        }
      }
    },

    close,
    pendingRequestCount: () => pending.size
  }
}
