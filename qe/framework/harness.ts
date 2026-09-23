/**
 * Test harness for the backend.
 *
 * Starts a real server on an ephemeral port and hands back typed clients for
 * all three protocols. Tests get a running system, not a mocked one: the
 * serialisation, the routing and the schema validation are all part of what is
 * under test, and a mock would skip exactly the layer where the interesting
 * bugs live.
 */
import type { FastifyInstance } from 'fastify'
import { WebSocket } from 'ws'
import { buildServer, DEFAULT_MARKET, type ServerOptions } from '../../sut/backend/server.ts'
import { MarketDataMessage } from '../../sut/backend/wire.ts'
import type { Market } from '../../sut/backend/ledger.ts'

export interface Harness {
  readonly app: FastifyInstance
  readonly baseUrl: string
  readonly market: Market
  get<T = unknown>(path: string): Promise<{ status: number; body: T }>
  post<T = unknown>(path: string, body: unknown): Promise<{ status: number; body: T }>
  del<T = unknown>(path: string): Promise<{ status: number; body: T }>
  rpc(method: string, params?: unknown, id?: string | number | null): Promise<unknown>
  /** Open a market data socket that records every message it receives. */
  marketData(): Promise<MarketDataFeed>
  stop(): Promise<void>
}

export interface MarketDataFeed {
  readonly messages: MarketDataMessage[]
  /** Wait until at least `count` messages have arrived, or time out. */
  waitFor(count: number, timeoutMs?: number): Promise<void>
  close(): Promise<void>
}

export async function startHarness(options: ServerOptions = {}): Promise<Harness> {
  const app = await buildServer(options)
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  if (address === null || typeof address === 'string') throw new Error('no port assigned')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const sockets: WebSocket[] = []

  const request = async <T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: T }> => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    return {
      status: response.status,
      body: (text === '' ? undefined : JSON.parse(text)) as T,
    }
  }

  return {
    app,
    baseUrl,
    market: options.market ?? DEFAULT_MARKET,
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    del: (path) => request('DELETE', path),
    async rpc(method, params, id = 1) {
      const { body } = await request<{ result?: unknown; error?: unknown }>('POST', '/rpc', {
        jsonrpc: '2.0',
        id,
        method,
        ...(params === undefined ? {} : { params }),
      })
      return body
    },
    async marketData() {
      const socket = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws`)
      sockets.push(socket)
      const messages: MarketDataMessage[] = []
      socket.on('message', (data) => {
        // Parsed through the published schema, so a message that does not match
        // the contract fails the test rather than being silently accepted.
        messages.push(MarketDataMessage.parse(JSON.parse(String(data))))
      })
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve)
        socket.once('error', reject)
      })
      return {
        messages,
        async waitFor(count, timeoutMs = 2000) {
          const deadline = Date.now() + timeoutMs
          while (messages.length < count) {
            if (Date.now() > deadline) {
              throw new Error(`timed out waiting for ${count} messages, saw ${messages.length}`)
            }
            await new Promise((resolve) => setTimeout(resolve, 5))
          }
        },
        async close() {
          socket.close()
          await new Promise((resolve) => setTimeout(resolve, 10))
        },
      }
    },
    async stop() {
      for (const socket of sockets) socket.close()
      await app.close()
    },
  }
}
