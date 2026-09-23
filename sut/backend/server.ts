/**
 * HTTP, WebSocket and JSON-RPC front end for the exchange.
 *
 * Three protocols over one service on purpose, because that is the shape the
 * platform has and because each carries a different failure mode worth testing:
 * REST has a response contract, JSON-RPC has an error-code contract, and the
 * WebSocket feed has an ordering contract.
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'
import websocket from '@fastify/websocket'
import { z } from 'zod'
import { Exchange } from './exchange.ts'
import type { Market } from './ledger.ts'
import {
  encodeBigInts,
  JsonRpcRequest,
  RpcErrors,
  SubmitOrderRequest,
} from './wire.ts'
import type { OrderOutcome, OrderRequest, SubmitResult } from '../../spec/types.ts'

export const DEFAULT_MARKET: Market = {
  symbol: 'ETH-USDC',
  quoteScale: 10_000n,
  baseScale: 1_000_000n,
  makerFeeBps: 2n,
  takerFeeBps: 7n,
}

/** Map an engine outcome onto the API's status vocabulary. */
function statusOf(outcome: OrderOutcome): { status: string; reason: string | null } {
  switch (outcome.kind) {
    case 'rejected':
      return { status: 'rejected', reason: outcome.reason }
    case 'filled':
      return { status: 'filled', reason: null }
    case 'resting':
      return { status: 'resting', reason: null }
    case 'partially_filled_and_cancelled':
      return { status: 'cancelled', reason: null }
    case 'triggered_later':
      return { status: 'pending_trigger', reason: null }
  }
}

function encodeSubmit(result: SubmitResult, requested: bigint): unknown {
  const filled = result.trades.reduce((sum, t) => sum + t.quantity, 0n)
  const { status, reason } = statusOf(result.outcome)
  return {
    orderId: result.orderId,
    status,
    reason,
    filled: filled.toString(),
    remaining: (requested - filled).toString(),
    trades: result.trades.map((t) => ({
      id: t.id,
      takerOrderId: t.takerOrderId,
      makerOrderId: t.makerOrderId,
      takerSide: t.takerSide,
      price: t.price.toString(),
      quantity: t.quantity.toString(),
    })),
    cancelledOrderIds: [...result.cancelled],
  }
}

function toOrderRequest(exchange: Exchange, body: z.output<typeof SubmitOrderRequest>): OrderRequest {
  return {
    id: exchange.nextOrderId(),
    accountId: body.accountId,
    side: body.side,
    type: body.type,
    tif: body.tif,
    price: body.price,
    quantity: body.quantity,
    displayQuantity: body.displayQuantity,
    postOnly: body.postOnly,
    reduceOnly: body.reduceOnly,
    triggerPrice: body.triggerPrice,
    stpMode: body.stpMode,
  }
}

export interface ServerOptions {
  readonly market?: Market
  readonly exchange?: Exchange
}

export async function buildServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  const exchange = options.exchange ?? new Exchange(options.market ?? DEFAULT_MARKET)
  const app = Fastify({ logger: false })
  await app.register(websocket)

  // The UI is served by the same origin as the API. Same-origin keeps the
  // end-to-end tests honest: no CORS shim standing between the page and the
  // service that a production deployment would not have.
  const frontendDir = resolve(dirname(fileURLToPath(import.meta.url)), '../frontend')
  await app.register(fastifyStatic, { root: frontendDir, prefix: '/' })

  app.decorate('exchange', exchange)

  // ------------------------------------------------------------------ REST

  app.get('/health', async () => ({ status: 'ok', sequence: exchange.sequence }))

  app.post('/orders', async (request, reply) => {
    const parsed = SubmitOrderRequest.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      })
    }
    // An unaffordable order is a 422 like any other refusal. A settlement
    // failure after matching is SettlementInconsistencyError, and a 500 is the
    // honest answer to that: the exchange is in a state it should never reach.
    const order = toOrderRequest(exchange, parsed.data)
    const result = exchange.submit(order)
    const code = result.outcome.kind === 'rejected' ? 422 : 201
    return reply.code(code).send(encodeSubmit(result, order.quantity))
  })

  app.delete<{ Params: { id: string } }>('/orders/:id', async (request, reply) => {
    const result = exchange.cancel(request.params.id)
    return reply.code(200).send({
      orderId: result.orderId,
      cancelled: result.cancelled,
      remainingAtCancel: result.remainingAtCancel.toString(),
    })
  })

  app.get('/book', async () => {
    const { bids, asks } = exchange.book()
    return encodeBigInts({ sequence: exchange.sequence, bids, asks })
  })

  app.get<{ Params: { id: string } }>('/accounts/:id', async (request) => {
    const id = request.params.id
    const balance = exchange.ledger.balanceOf(id)
    return {
      accountId: id,
      base: balance.base.toString(),
      quote: balance.quote.toString(),
      position: exchange.position(id).toString(),
    }
  })

  app.get('/trades', async () => encodeBigInts({ trades: exchange.recentTrades() }))

  // -------------------------------------------------------------- JSON-RPC

  const rpcMethods: Record<string, (params: unknown) => unknown> = {
    exchange_getBook: () => {
      const { bids, asks } = exchange.book()
      return encodeBigInts({ sequence: exchange.sequence, bids, asks })
    },
    exchange_getBalance: (params) => {
      const p = z.object({ accountId: z.string() }).parse(params)
      const balance = exchange.ledger.balanceOf(p.accountId)
      return {
        accountId: p.accountId,
        base: balance.base.toString(),
        quote: balance.quote.toString(),
        position: exchange.position(p.accountId).toString(),
      }
    },
    exchange_submitOrder: (params) => {
      const body = SubmitOrderRequest.parse(params)
      const order = toOrderRequest(exchange, body)
      return encodeSubmit(exchange.submit(order), order.quantity)
    },
    exchange_cancelOrder: (params) => {
      const p = z.object({ orderId: z.string() }).parse(params)
      const result = exchange.cancel(p.orderId)
      return {
        orderId: result.orderId,
        cancelled: result.cancelled,
        remainingAtCancel: result.remainingAtCancel.toString(),
      }
    },
  }

  app.post('/rpc', async (request, reply) => {
    const parsed = JsonRpcRequest.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(200).send({
        jsonrpc: '2.0',
        id: null,
        error: { code: RpcErrors.invalidRequest, message: 'invalid request' },
      })
    }
    const { id, method, params } = parsed.data
    const handler = rpcMethods[method]
    if (handler === undefined) {
      return reply.code(200).send({
        jsonrpc: '2.0',
        id,
        error: { code: RpcErrors.methodNotFound, message: `unknown method ${method}` },
      })
    }
    try {
      return reply.code(200).send({ jsonrpc: '2.0', id, result: handler(params) })
    } catch (error) {
      const code = error instanceof z.ZodError ? RpcErrors.invalidParams : RpcErrors.internalError
      const message = error instanceof Error ? error.message : 'internal error'
      return reply.code(200).send({ jsonrpc: '2.0', id, error: { code, message } })
    }
  })

  // ------------------------------------------------------------- WebSocket

  app.get('/ws', { websocket: true }, (socket) => {
    const send = (message: unknown): void => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
    }
    // Snapshot first, then every subsequent message in sequence. A consumer
    // that sees a gap between the snapshot's sequence and the first delta has
    // missed a message and must re-snapshot.
    send(exchange.snapshotMessage())
    const unsubscribe = exchange.subscribe(send)
    socket.on('close', unsubscribe)
  })

  return app
}
