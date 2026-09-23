/**
 * JSON-RPC contract.
 *
 * The error codes are the contract here. A client that cannot tell "you sent
 * nonsense" from "the exchange refused your order" from "the exchange is
 * broken" will retry the wrong ones, and retrying a rejected order on an
 * exchange is how one mistake becomes a position.
 *
 * The last block asserts REST and JSON-RPC agree. Two front ends over one
 * service drift, and the drift is invisible until a client using one protocol
 * reports a number a client using the other cannot reproduce.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startHarness, type Harness } from '../../framework/harness.ts'
import { JsonRpcResponse, RpcErrors } from '../../../sut/backend/wire.ts'

let harness: Harness

beforeEach(async () => {
  harness = await startHarness()
  harness.exchange.deposit('alice', 10n ** 18n, 10n ** 24n)
  harness.exchange.deposit('bob', 10n ** 18n, 10n ** 24n)
})
afterEach(async () => {
  await harness.stop()
})

const asResult = (response: unknown): Record<string, unknown> => {
  const parsed = JsonRpcResponse.parse(response)
  if (!('result' in parsed)) throw new Error(`expected a result, got ${JSON.stringify(parsed)}`)
  return parsed.result as Record<string, unknown>
}
const asError = (response: unknown): { code: number; message: string } => {
  const parsed = JsonRpcResponse.parse(response)
  if (!('error' in parsed)) throw new Error(`expected an error, got ${JSON.stringify(parsed)}`)
  return parsed.error
}

describe('JSON-RPC envelope', () => {
  it('echoes the request id', async () => {
    const response = await harness.rpc('exchange_getBook', undefined, 'abc-123')

    expect(JsonRpcResponse.parse(response).id).toBe('abc-123')
  })

  it('returns method not found for an unknown method', async () => {
    const error = asError(await harness.rpc('exchange_doesNotExist'))

    expect(error.code).toBe(RpcErrors.methodNotFound)
  })

  it('returns invalid params for a malformed payload', async () => {
    const error = asError(await harness.rpc('exchange_getBalance', { wrong: 'shape' }))

    expect(error.code).toBe(RpcErrors.invalidParams)
  })

  it('returns invalid request for a body that is not JSON-RPC', async () => {
    const { body } = await harness.post('/rpc', { not: 'jsonrpc' })

    expect(asError(body).code).toBe(RpcErrors.invalidRequest)
  })

  it('uses HTTP 200 for application errors, so transport and domain stay separate', async () => {
    const { status } = await harness.post('/rpc', {
      jsonrpc: '2.0',
      id: 1,
      method: 'exchange_doesNotExist',
    })

    expect(status).toBe(200)
  })
})

describe('JSON-RPC methods', () => {
  it('submits an order and reports the fill', async () => {
    await harness.rpc('exchange_submitOrder', {
      accountId: 'bob',
      side: 'sell',
      price: '100',
      quantity: '2',
    })

    const result = asResult(
      await harness.rpc('exchange_submitOrder', {
        accountId: 'alice',
        side: 'buy',
        price: '100',
        quantity: '2',
      }),
    )

    expect(result.status).toBe('filled')
    expect(result.filled).toBe('2')
  })

  it('reports a domain rejection as a result, not a transport error', async () => {
    // The request was well formed and the exchange understood it. The order was
    // refused. A client must be able to tell that apart from a broken call.
    const result = asResult(
      await harness.rpc('exchange_submitOrder', {
        accountId: 'alice',
        side: 'buy',
        price: '100',
        quantity: '0',
      }),
    )

    expect(result.status).toBe('rejected')
    expect(result.reason).toBe('invalid_quantity')
  })

  it('cancels an order', async () => {
    const placed = asResult(
      await harness.rpc('exchange_submitOrder', {
        accountId: 'alice',
        side: 'buy',
        price: '100',
        quantity: '5',
      }),
    )

    const cancelled = asResult(
      await harness.rpc('exchange_cancelOrder', { orderId: placed.orderId }),
    )

    expect(cancelled).toMatchObject({ cancelled: true, remainingAtCancel: '5' })
  })
})

describe('protocol agreement', () => {
  it('returns the same book over REST and JSON-RPC', async () => {
    await harness.post('/orders', { accountId: 'alice', side: 'buy', price: '100', quantity: '5' })
    await harness.post('/orders', { accountId: 'bob', side: 'sell', price: '101', quantity: '3' })

    const rest = (await harness.get('/book')).body
    const rpc = asResult(await harness.rpc('exchange_getBook'))

    expect(rpc).toEqual(rest)
  })

  it('returns the same account state over REST and JSON-RPC', async () => {
    const rest = (await harness.get('/accounts/alice')).body
    const rpc = asResult(await harness.rpc('exchange_getBalance', { accountId: 'alice' }))

    expect(rpc).toEqual(rest)
  })

  it('applies the same validation rules on both protocols', async () => {
    const rest = await harness.post('/orders', {
      accountId: 'alice',
      side: 'buy',
      price: '100',
      quantity: 5,
    })
    const rpc = await harness.rpc('exchange_submitOrder', {
      accountId: 'alice',
      side: 'buy',
      price: '100',
      quantity: 5,
    })

    // A JSON number is refused by both, by different mechanisms and with
    // different codes, but refused.
    expect(rest.status).toBe(400)
    expect(asError(rpc).code).toBe(RpcErrors.invalidParams)
  })
})
