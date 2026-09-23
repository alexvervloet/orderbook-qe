/**
 * REST contract tests.
 *
 * Every response is parsed through the published schema rather than picked at
 * by hand. A test that reads `body.orderId` and ignores the rest will keep
 * passing while a field silently changes type, and a client integrating
 * against the documented shape will not.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startHarness, type Harness } from '../../framework/harness.ts'
import {
  AccountResponse,
  BookResponse,
  CancelResponse,
  ErrorResponse,
  SubmitOrderResponse,
} from '../../../sut/backend/wire.ts'

let harness: Harness

beforeEach(async () => {
  harness = await startHarness()
  harness.app.exchange.deposit('alice', 10n ** 18n, 10n ** 24n)
  harness.app.exchange.deposit('bob', 10n ** 18n, 10n ** 24n)
})
afterEach(async () => {
  await harness.stop()
})

const order = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  accountId: 'alice',
  side: 'buy',
  price: '100',
  quantity: '5',
  ...over,
})

describe('POST /orders', () => {
  it('returns a response matching the published schema', async () => {
    const { status, body } = await harness.post('/orders', order())

    expect(status).toBe(201)
    expect(() => SubmitOrderResponse.parse(body)).not.toThrow()
  })

  it('reports a rejection as 422 with a machine-readable reason', async () => {
    const { status, body } = await harness.post('/orders', order({ quantity: '0' }))

    expect(status).toBe(422)
    const parsed = SubmitOrderResponse.parse(body)
    expect(parsed.status).toBe('rejected')
    expect(parsed.reason).toBe('invalid_quantity')
  })

  it('reports a malformed body as 400 without touching the book', async () => {
    const before = await harness.get('/book')

    const { status, body } = await harness.post('/orders', { accountId: 'alice' })

    expect(status).toBe(400)
    expect(() => ErrorResponse.parse(body)).not.toThrow()
    expect((await harness.get('/book')).body).toEqual(before.body)
  })

  it('rejects a quantity sent as a JSON number rather than a string', async () => {
    // Numbers are refused at the edge. Accepting them would mean accepting
    // silent precision loss on large values.
    const { status } = await harness.post('/orders', order({ quantity: 5 }))

    expect(status).toBe(400)
  })

  it('preserves integers above 2^53 exactly', async () => {
    // 9007199254740993 cannot be represented as a JavaScript number. If any
    // layer parses it as one, it comes back as ...992 and the client is filled
    // for a size it never asked for.
    const huge = '9007199254740993'
    const { status, body } = await harness.post(
      '/orders',
      order({ accountId: 'bob', side: 'sell', price: '100', quantity: huge }),
    )

    expect(status).toBe(201)
    const parsed = SubmitOrderResponse.parse(body)
    expect(parsed.remaining).toBe(huge)
    expect(BigInt(parsed.remaining)).toBe(9_007_199_254_740_993n)

    // The same value through a JSON number, which is the bug this guards
    // against: one unit of size disappears and nothing anywhere errors.
    expect(Number(huge)).toBe(9_007_199_254_740_992)

    const book = BookResponse.parse((await harness.get('/book')).body)
    expect(book.asks[0]?.quantity).toBe(huge)
  })
})

describe('DELETE /orders/:id', () => {
  it('cancels a resting order', async () => {
    const { body } = await harness.post('/orders', order())
    const { orderId } = SubmitOrderResponse.parse(body)

    const response = await harness.del(`/orders/${orderId}`)

    expect(response.status).toBe(200)
    expect(CancelResponse.parse(response.body)).toMatchObject({
      cancelled: true,
      remainingAtCancel: '5',
    })
  })

  it('is idempotent and returns 200 for an unknown id', async () => {
    const response = await harness.del('/orders/never-existed')

    expect(response.status).toBe(200)
    expect(CancelResponse.parse(response.body).cancelled).toBe(false)
  })
})

describe('GET /book and /accounts/:id', () => {
  it('returns depth matching the schema', async () => {
    await harness.post('/orders', order())
    const { body } = await harness.get('/book')

    const book = BookResponse.parse(body)
    expect(book.bids[0]).toMatchObject({ price: '100', quantity: '5', orderCount: 1 })
  })

  it('returns an account with balances and position as strings', async () => {
    const { body } = await harness.get('/accounts/alice')

    expect(() => AccountResponse.parse(body)).not.toThrow()
  })

  it('moves balances and positions in opposite directions after a trade', async () => {
    await harness.post('/orders', order({ accountId: 'bob', side: 'sell', price: '100', quantity: '2' }))
    await harness.post('/orders', order({ accountId: 'alice', side: 'buy', price: '100', quantity: '2' }))

    const alice = AccountResponse.parse((await harness.get('/accounts/alice')).body)
    const bob = AccountResponse.parse((await harness.get('/accounts/bob')).body)

    expect(alice.position).toBe('2')
    expect(bob.position).toBe('-2')
    expect(BigInt(alice.base)).toBeGreaterThan(10n ** 18n)
    expect(BigInt(bob.base)).toBeLessThan(10n ** 18n)
  })
})
