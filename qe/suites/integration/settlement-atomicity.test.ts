/**
 * Matching and settlement must agree, always.
 *
 * Found by an end-to-end test, but it belongs here: the browser was never the
 * point, and this suite runs in milliseconds with a failure message that names
 * the mechanism. The end-to-end version stays as one case; these cover the
 * shape of the problem.
 *
 * The bug: the exchange matched first and settled second, so an account that
 * could not pay still consumed a maker's resting order. The book changed,
 * positions moved, settlement threw, and the ledger never moved. The maker lost
 * their liquidity for a trade that did not happen.
 * See docs/FAILURE-MODES.md.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { Exchange } from '../../../sut/backend/exchange.ts'
import { DEFAULT_MARKET } from '../../../sut/backend/server.ts'
import type { OrderRequest, Side } from '../../../spec/types.ts'
import { resetOrderIds } from '../../framework/orders.ts'

let exchange: Exchange

beforeEach(() => {
  resetOrderIds()
  exchange = new Exchange(DEFAULT_MARKET)
  exchange.deposit('rich', 10n ** 24n, 10n ** 30n)
  exchange.deposit('broke', 0n, 0n)
  // Enough base to sell, no quote at all to buy with.
  exchange.deposit('base-only', 10n ** 24n, 0n)
})

function order(
  accountId: string,
  side: Side,
  price: bigint | null,
  quantity: bigint,
  overrides: Partial<OrderRequest> = {},
): OrderRequest {
  return {
    id: `o-${accountId}-${side}-${price ?? 'mkt'}-${quantity}-${Math.random()}`,
    accountId,
    side,
    type: price === null ? 'market' : 'limit',
    tif: price === null ? 'IOC' : 'GTC',
    price,
    quantity,
    displayQuantity: null,
    postOnly: false,
    reduceOnly: false,
    triggerPrice: null,
    stpMode: 'none',
    ...overrides,
  }
}

const reason = (result: ReturnType<Exchange['submit']>): string =>
  result.outcome.kind === 'rejected' ? result.outcome.reason : `not rejected: ${result.outcome.kind}`

describe('an order that cannot settle never matches', () => {
  it('refuses an unfunded taker and leaves the maker resting', () => {
    exchange.submit(order('rich', 'sell', 100n, 5n))
    const bookBefore = exchange.book()

    const result = exchange.submit(order('broke', 'buy', 100n, 5n))

    expect(reason(result)).toBe('insufficient_funds')
    expect(result.trades).toEqual([])
    expect(exchange.book()).toEqual(bookBefore)
    expect(exchange.position('broke')).toBe(0n)
    expect(exchange.position('rich')).toBe(0n)
  })

  it('refuses a seller who does not hold the base', () => {
    exchange.submit(order('rich', 'buy', 100n, 5n))

    const result = exchange.submit(order('broke', 'sell', 100n, 5n))

    expect(reason(result)).toBe('insufficient_funds')
    expect(exchange.book().bids[0]?.quantity).toBe(5n)
  })

  it('refuses a seller who holds the base but cannot pay the fee', () => {
    exchange.submit(order('rich', 'buy', 100n, 5n))

    // The fee is charged in quote, and this account has none. An exchange that
    // only checks the asset being sold misses this.
    const result = exchange.submit(order('base-only', 'sell', 100n, 5n))

    expect(reason(result)).toBe('insufficient_funds')
  })

  it('refuses an unfunded market order against a deep book', () => {
    exchange.submit(order('rich', 'sell', 100n, 5n))
    exchange.submit(order('rich', 'sell', 200n, 5n))
    const bookBefore = exchange.book()

    const result = exchange.submit(order('broke', 'buy', null, 10n))

    expect(reason(result)).toBe('insufficient_funds')
    expect(exchange.book()).toEqual(bookBefore)
  })

  it('allows a market order against an empty book, which costs nothing', () => {
    // No liquidity means no execution, so affordability is not in question.
    // Rejecting here would be the conservative check becoming wrong.
    const result = exchange.submit(order('broke', 'buy', null, 10n))

    expect(result.outcome.kind).not.toBe('rejected')
    expect(result.trades).toEqual([])
  })

  it('refuses an unfunded stop at submission, before it can trigger', () => {
    // A stop skipped the check entirely. When it later triggered inside
    // somebody else's order, settlement threw mid-submit, after the engine
    // had already moved: the original bug, by another door.
    exchange.submit(order('rich', 'sell', 100n, 5n))

    const stop = exchange.submit(
      order('broke', 'buy', null, 5n, { type: 'stop_market', tif: 'IOC', triggerPrice: 100n }),
    )
    expect(reason(stop)).toBe('insufficient_funds')

    // The trade that would have triggered it goes through cleanly.
    exchange.deposit('buyer', 0n, 10n ** 30n)
    expect(() => exchange.submit(order('buyer', 'buy', 100n, 1n))).not.toThrow()
    expect(exchange.position('broke')).toBe(0n)
  })

  it('prices a stop_limit at its limit, like any limit order', () => {
    exchange.deposit('small', 0n, 1n)
    const stop = exchange.submit(
      order('small', 'buy', 100n, 5n, { type: 'stop_limit', triggerPrice: 100n }),
    )
    expect(reason(stop)).toBe('insufficient_funds')
  })

  it('prices a stop_market into an empty book at its trigger', () => {
    // Nothing to trade against yet, so the trigger is the only price there
    // is. The order still has to be affordable at that price.
    const stop = exchange.submit(
      order('broke', 'buy', null, 5n, { type: 'stop_market', tif: 'IOC', triggerPrice: 100n }),
    )
    expect(reason(stop)).toBe('insufficient_funds')
  })

  it('accepts a funded stop', () => {
    const stop = exchange.submit(
      order('rich', 'buy', null, 5n, { type: 'stop_market', tif: 'IOC', triggerPrice: 100n }),
    )
    expect(stop.outcome.kind).toBe('triggered_later')
  })

  it('still fills an account that can afford the trade', () => {
    exchange.submit(order('rich', 'sell', 100n, 5n))
    exchange.deposit('buyer', 0n, 10n ** 30n)

    const result = exchange.submit(order('buyer', 'buy', 100n, 5n))

    expect(result.outcome.kind).toBe('filled')
    expect(exchange.position('buyer')).toBe(5n)
  })
})

describe('the ledger and the engine never disagree', () => {
  it('keeps positions and balances consistent across a mixed session', () => {
    exchange.deposit('a', 10n ** 22n, 10n ** 28n)
    exchange.deposit('b', 10n ** 22n, 10n ** 28n)

    exchange.submit(order('a', 'sell', 100n, 5n))
    exchange.submit(order('b', 'buy', 100n, 3n))
    exchange.submit(order('broke', 'buy', 100n, 2n)) // refused
    exchange.submit(order('b', 'buy', 100n, 2n))

    // Every trade that the engine recorded is a trade the ledger settled, so
    // base moved by exactly the position change times the scale.
    for (const account of ['a', 'b'] as const) {
      const expectedBase = 10n ** 22n + exchange.position(account) * DEFAULT_MARKET.baseScale
      expect(exchange.ledger.baseOf(account), `base for ${account}`).toBe(expectedBase)
    }
    expect(exchange.position('broke')).toBe(0n)
  })
})
