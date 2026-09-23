/**
 * Domain types shared by both matching engine implementations.
 *
 * These types are the contract, not an implementation. The reference engine in
 * `qe/model` and the production engine in `sut/backend` both import them, which
 * is what makes a differential test between the two meaningful: they agree on
 * vocabulary and disagree only where one of them is wrong.
 *
 * All prices and quantities are integers. Price is a count of ticks, quantity a
 * count of lots. There is no floating point anywhere in this file or downstream
 * of it. See docs/PRECISION.md for why.
 */

/** Price in whole ticks. Multiply by `Market.tickSize` for a real price. */
export type Ticks = bigint

/** Quantity in whole lots. Multiply by `Market.lotSize` for a real size. */
export type Lots = bigint

export type OrderId = string
export type AccountId = string
export type TradeId = string

/** Monotonic arrival counter. Decides time priority, and nothing else. */
export type Sequence = number

export type Side = 'buy' | 'sell'

export function opposite(side: Side): Side {
  return side === 'buy' ? 'sell' : 'buy'
}

/**
 * GTC rests until filled or cancelled.
 * IOC fills what it can immediately and cancels the remainder.
 * FOK fills completely and immediately or does not execute at all.
 */
export type TimeInForce = 'GTC' | 'IOC' | 'FOK'

export type OrderType = 'limit' | 'market' | 'stop_market' | 'stop_limit'

/**
 * What to do when an incoming order would match against resting liquidity from
 * the same account. Exchanges differ here, so the behaviour is explicit per
 * order rather than assumed.
 */
export type StpMode = 'none' | 'cancel_taker' | 'cancel_maker' | 'cancel_both'

/** An order as submitted by a client, before the engine has seen it. */
export interface OrderRequest {
  readonly id: OrderId
  readonly accountId: AccountId
  readonly side: Side
  readonly type: OrderType
  readonly tif: TimeInForce
  /** Limit price in ticks. Null for `market` and `stop_market`. */
  readonly price: Ticks | null
  readonly quantity: Lots
  /**
   * Iceberg display size in lots. When set, only this much is visible and
   * matchable at a time. Null means the whole order is visible.
   */
  readonly displayQuantity: Lots | null
  /** Reject rather than rest if the order would take liquidity on arrival. */
  readonly postOnly: boolean
  /** Never increase the magnitude of the account's open position. */
  readonly reduceOnly: boolean
  /** Trigger price in ticks for `stop_market` and `stop_limit`. Null otherwise. */
  readonly triggerPrice: Ticks | null
  readonly stpMode: StpMode
}

/** An order the engine has accepted and is tracking. */
export interface RestingOrder {
  readonly request: OrderRequest
  /** Arrival order at the order's current queue position. */
  readonly sequence: Sequence
  /** Lots not yet filled, visible or hidden. */
  readonly remaining: Lots
  /**
   * Lots currently visible at the price level. Equals `remaining` unless the
   * order is an iceberg.
   */
  readonly displayed: Lots
}

export interface Trade {
  readonly id: TradeId
  readonly takerOrderId: OrderId
  readonly makerOrderId: OrderId
  readonly takerAccountId: AccountId
  readonly makerAccountId: AccountId
  /** Side of the taker. The maker is on the opposite side. */
  readonly takerSide: Side
  /** Execution price in ticks. Always the resting maker's price. */
  readonly price: Ticks
  readonly quantity: Lots
  readonly sequence: Sequence
}

export type RejectReason =
  | 'post_only_would_cross'
  | 'fok_not_fully_fillable'
  | 'reduce_only_no_position'
  | 'reduce_only_wrong_side'
  | 'self_trade_prevented'
  | 'invalid_price'
  | 'invalid_quantity'
  | 'invalid_display_quantity'
  | 'invalid_trigger_price'
  | 'market_order_cannot_rest'
  | 'duplicate_order_id'
  | 'unknown_order'
  | 'insufficient_funds'

/** What happened to a submitted order, as a whole. */
export type OrderOutcome =
  | { readonly kind: 'rejected'; readonly reason: RejectReason }
  | { readonly kind: 'filled' }
  | { readonly kind: 'partially_filled_and_cancelled'; readonly unfilled: Lots }
  | { readonly kind: 'resting'; readonly remaining: Lots }
  | { readonly kind: 'triggered_later' }

export interface SubmitResult {
  readonly orderId: OrderId
  readonly outcome: OrderOutcome
  readonly trades: readonly Trade[]
  /** Resting orders cancelled as a side effect, for example by STP. */
  readonly cancelled: readonly OrderId[]
}

export interface CancelResult {
  readonly orderId: OrderId
  /** False when the order was already gone. Cancel is idempotent, not an error. */
  readonly cancelled: boolean
  readonly remainingAtCancel: Lots
}

/** One visible price level, as a market data consumer would see it. */
export interface BookLevel {
  readonly price: Ticks
  /** Sum of `displayed` across resting orders. Hidden iceberg size is excluded. */
  readonly quantity: Lots
  readonly orderCount: number
}

/**
 * The full observable state of a book. This is the object the differential test
 * compares between implementations, so it must contain everything that is
 * externally meaningful and nothing that is an implementation detail.
 */
export interface BookSnapshot {
  /** Descending by price. */
  readonly bids: readonly BookLevel[]
  /** Ascending by price. */
  readonly asks: readonly BookLevel[]
}
