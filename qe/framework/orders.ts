/**
 * Order builders for tests.
 *
 * Tests should say what is interesting about an order and nothing else. A test
 * about iceberg refresh should not have to decide a time in force, and a test
 * about FOK should not have to decide an STP mode. Everything unstated comes
 * from one place, so when a default changes, every test changes with it.
 */
import type { Lots, OrderId, OrderRequest, Side, Ticks } from '../../spec/types.ts'

let counter = 0

/** Reset between tests so ids are stable and counterexamples are readable. */
export function resetOrderIds(): void {
  counter = 0
}

export function nextOrderId(prefix = 'o'): OrderId {
  return `${prefix}${counter++}`
}

type Overrides = Partial<Omit<OrderRequest, 'side'>>

function build(side: Side, overrides: Overrides): OrderRequest {
  return {
    id: overrides.id ?? nextOrderId(),
    accountId: overrides.accountId ?? 'alice',
    side,
    type: overrides.type ?? 'limit',
    tif: overrides.tif ?? 'GTC',
    price: overrides.price ?? null,
    quantity: overrides.quantity ?? 1n,
    displayQuantity: overrides.displayQuantity ?? null,
    postOnly: overrides.postOnly ?? false,
    reduceOnly: overrides.reduceOnly ?? false,
    triggerPrice: overrides.triggerPrice ?? null,
    stpMode: overrides.stpMode ?? 'none',
  }
}

/** A resting limit buy. `buy(100n, 5n)` is five lots bid at tick 100. */
export function buy(price: Ticks, quantity: Lots, overrides: Overrides = {}): OrderRequest {
  return build('buy', { type: 'limit', price, quantity, ...overrides })
}

export function sell(price: Ticks, quantity: Lots, overrides: Overrides = {}): OrderRequest {
  return build('sell', { type: 'limit', price, quantity, ...overrides })
}

export function marketBuy(quantity: Lots, overrides: Overrides = {}): OrderRequest {
  return build('buy', { type: 'market', tif: 'IOC', price: null, quantity, ...overrides })
}

export function marketSell(quantity: Lots, overrides: Overrides = {}): OrderRequest {
  return build('sell', { type: 'market', tif: 'IOC', price: null, quantity, ...overrides })
}

export function stopMarket(
  side: Side,
  triggerPrice: Ticks,
  quantity: Lots,
  overrides: Overrides = {},
): OrderRequest {
  return build(side, {
    type: 'stop_market',
    tif: 'IOC',
    price: null,
    triggerPrice,
    quantity,
    ...overrides,
  })
}

export function stopLimit(
  side: Side,
  triggerPrice: Ticks,
  price: Ticks,
  quantity: Lots,
  overrides: Overrides = {},
): OrderRequest {
  return build(side, {
    type: 'stop_limit',
    price,
    triggerPrice,
    quantity,
    ...overrides,
  })
}
