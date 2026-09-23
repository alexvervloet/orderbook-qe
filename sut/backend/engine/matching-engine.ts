/**
 * The production matching engine.
 *
 * Same observable behaviour as qe/model/reference-engine.ts, different
 * machinery: price levels in a map, an intrusive linked list per level, an
 * order index for constant-time cancel, and a sorted array of occupied prices.
 *
 * This file is the system under test. It is written as a genuine attempt at a
 * correct fast engine, with no bugs planted in it. Whatever the differential
 * suite finds here, it found honestly.
 */
import type { MatchingEngine } from '../../../spec/engine.ts'
import {
  opposite,
  type AccountId,
  type BookLevel,
  type BookSnapshot,
  type CancelResult,
  type Lots,
  type OrderId,
  type OrderRequest,
  type RejectReason,
  type RestingOrder,
  type Sequence,
  type Side,
  type SubmitResult,
  type Ticks,
  type Trade,
} from '../../../spec/types.ts'
import { BookSide, type Node } from './book-side.ts'

interface StopEntry {
  readonly request: OrderRequest
  readonly sequence: Sequence
  readonly remaining: Lots
}

interface MatchRun {
  readonly trades: Trade[]
  readonly cancelled: OrderId[]
  readonly remaining: Lots
  readonly stoppedByStp: boolean
}

interface Executed {
  readonly result: SubmitResult
  /** The node the order rested as, if it rested. */
  readonly rested: Node | null
}

export class ProductionMatchingEngine implements MatchingEngine {
  readonly #bids = new BookSide('buy')
  readonly #asks = new BookSide('sell')
  readonly #index = new Map<OrderId, Node>()
  readonly #stops = new Map<OrderId, StopEntry>()
  readonly #knownIds = new Set<OrderId>()
  readonly #positions = new Map<AccountId, Lots>()
  #sequence: Sequence = 0
  #tradeCounter = 0
  #lastTradePrice: Ticks | null = null

  // ---------------------------------------------------------------- public

  submit(request: OrderRequest): SubmitResult {
    const invalid = this.#validate(request)
    if (invalid !== null) return reject(request.id, invalid)

    this.#knownIds.add(request.id)

    if (request.type === 'stop_market' || request.type === 'stop_limit') {
      return this.#submitStop(request)
    }
    return this.#submitActive(request)
  }

  cancel(orderId: OrderId): CancelResult {
    const node = this.#index.get(orderId)
    if (node !== undefined) {
      this.#side(node.request.side).remove(node)
      this.#index.delete(orderId)
      return { orderId, cancelled: true, remainingAtCancel: node.remaining }
    }
    const stop = this.#stops.get(orderId)
    if (stop !== undefined) {
      this.#stops.delete(orderId)
      return { orderId, cancelled: true, remainingAtCancel: stop.remaining }
    }
    return { orderId, cancelled: false, remainingAtCancel: 0n }
  }

  snapshot(): BookSnapshot {
    return { bids: levelsOf(this.#bids), asks: levelsOf(this.#asks) }
  }

  restingOrders(): readonly RestingOrder[] {
    const out: RestingOrder[] = []
    for (const node of this.#bids.nodes()) out.push(freeze(node))
    for (const node of this.#asks.nodes()) out.push(freeze(node))
    return out
  }

  pendingStops(): readonly RestingOrder[] {
    return [...this.#stops.values()]
      .sort((a, b) => a.sequence - b.sequence)
      .map((s) => ({
        request: s.request,
        sequence: s.sequence,
        remaining: s.remaining,
        displayed: s.request.displayQuantity ?? s.remaining,
      }))
  }

  lastTradePrice(): Ticks | null {
    return this.#lastTradePrice
  }

  position(accountId: AccountId): Lots {
    return this.#positions.get(accountId) ?? 0n
  }

  // --------------------------------------------------------------- private

  #side(side: Side): BookSide {
    return side === 'buy' ? this.#bids : this.#asks
  }

  #validate(r: OrderRequest): RejectReason | null {
    if (this.#knownIds.has(r.id)) return 'duplicate_order_id'
    if (r.quantity <= 0n) return 'invalid_quantity'

    const needsPrice = r.type === 'limit' || r.type === 'stop_limit'
    if (needsPrice && (r.price === null || r.price <= 0n)) return 'invalid_price'
    if (!needsPrice && r.price !== null) return 'invalid_price'

    const isStop = r.type === 'stop_market' || r.type === 'stop_limit'
    if (isStop && (r.triggerPrice === null || r.triggerPrice <= 0n)) {
      return 'invalid_trigger_price'
    }
    if (!isStop && r.triggerPrice !== null) return 'invalid_trigger_price'

    if (r.displayQuantity !== null) {
      if (r.displayQuantity <= 0n || r.displayQuantity > r.quantity) {
        return 'invalid_display_quantity'
      }
    }
    return null
  }

  #submitStop(request: OrderRequest): SubmitResult {
    this.#stops.set(request.id, {
      request,
      sequence: this.#sequence++,
      remaining: request.quantity,
    })

    const cascade = this.#runTriggerCascade()
    const outcome = cascade.outcomes.get(request.id)
    return {
      orderId: request.id,
      outcome: outcome ?? { kind: 'triggered_later' },
      trades: cascade.trades,
      cancelled: cascade.cancelled,
    }
  }

  #submitActive(request: OrderRequest): SubmitResult {
    const own = this.#execute(request)
    const cascade = this.#runTriggerCascade()
    return {
      orderId: request.id,
      outcome: this.#outcomeNow(own),
      trades: [...own.result.trades, ...cascade.trades],
      cancelled: [...own.result.cancelled, ...cascade.cancelled],
    }
  }

  /**
   * Match one order and rest its remainder. Never runs the trigger cascade: the
   * order must be finished before a stop it triggered can run, or the stop can
   * rest on the far side and the remainder rest through it.
   */
  #execute(request: OrderRequest): Executed {
    const capped = this.#applyReduceOnly(request)
    if ('reason' in capped) return { result: reject(request.id, capped.reason), rested: null }
    const effective = capped.request

    if (effective.postOnly && this.#wouldCross(effective)) {
      return { result: reject(request.id, 'post_only_would_cross'), rested: null }
    }
    if (effective.tif === 'FOK' && this.#fillableQuantity(effective) < effective.quantity) {
      return { result: reject(request.id, 'fok_not_fully_fillable'), rested: null }
    }

    const run = this.#match(effective)
    const done = (outcome: SubmitResult['outcome']): SubmitResult => ({
      orderId: request.id,
      outcome,
      trades: run.trades,
      cancelled: run.cancelled,
    })

    if (run.remaining === 0n) return { result: done({ kind: 'filled' }), rested: null }

    const canRest = effective.tif === 'GTC' && effective.type === 'limit' && !run.stoppedByStp
    if (!canRest) {
      return {
        result: done({ kind: 'partially_filled_and_cancelled', unfilled: run.remaining }),
        rested: null,
      }
    }

    const displayed = minOf(effective.displayQuantity ?? run.remaining, run.remaining)
    const node = this.#side(effective.side).append(
      effective,
      this.#sequence++,
      run.remaining,
      displayed,
    )
    this.#index.set(effective.id, node)
    return { result: done({ kind: 'resting', remaining: run.remaining }), rested: node }
  }

  /** The outcome as it stands on return, after any stop it triggered has run. */
  #outcomeNow(own: Executed): SubmitResult['outcome'] {
    const node = own.rested
    if (node === null) return own.result.outcome
    if (this.#index.get(node.request.id) === node) {
      return { kind: 'resting', remaining: node.remaining }
    }
    if (node.remaining === 0n) return { kind: 'filled' }
    return { kind: 'partially_filled_and_cancelled', unfilled: node.remaining }
  }

  #applyReduceOnly(
    r: OrderRequest,
  ): { request: OrderRequest } | { reason: RejectReason } {
    if (!r.reduceOnly) return { request: r }

    const position = this.position(r.accountId)
    if (position === 0n) return { reason: 'reduce_only_no_position' }

    const reducesLong = r.side === 'sell' && position > 0n
    const reducesShort = r.side === 'buy' && position < 0n
    if (!reducesLong && !reducesShort) return { reason: 'reduce_only_wrong_side' }

    const cap = position < 0n ? -position : position
    return r.quantity <= cap ? { request: r } : { request: { ...r, quantity: cap } }
  }

  #wouldCross(r: OrderRequest): boolean {
    const book = this.#side(opposite(r.side))
    const best = book.bestPrice()
    return best !== null && crosses(r, best)
  }

  #fillableQuantity(r: OrderRequest): Lots {
    const book = this.#side(opposite(r.side))
    let total = 0n
    for (const price of book.prices()) {
      if (!crosses(r, price)) break // prices are best-first, so nothing further can cross
      total += book.level(price)!.displayedTotal
      if (total >= r.quantity) return total
    }
    return total
  }

  #match(r: OrderRequest): MatchRun {
    const book = this.#side(opposite(r.side))
    const trades: Trade[] = []
    const cancelled: OrderId[] = []
    let remaining = r.quantity
    let stoppedByStp = false

    while (remaining > 0n) {
      const maker = book.bestNode()
      if (maker === null) break
      if (!crosses(r, maker.request.price!)) break

      if (maker.request.accountId === r.accountId && r.stpMode !== 'none') {
        if (r.stpMode === 'cancel_taker') {
          stoppedByStp = true
          break
        }
        book.remove(maker)
        this.#index.delete(maker.request.id)
        cancelled.push(maker.request.id)
        if (r.stpMode === 'cancel_both') {
          stoppedByStp = true
          break
        }
        continue
      }

      const quantity = minOf(remaining, maker.displayed)
      const price = maker.request.price!
      trades.push({
        id: `t${this.#tradeCounter++}`,
        takerOrderId: r.id,
        makerOrderId: maker.request.id,
        takerAccountId: r.accountId,
        makerAccountId: maker.request.accountId,
        takerSide: r.side,
        price,
        quantity,
        sequence: this.#sequence++,
      })

      remaining -= quantity
      maker.remaining -= quantity
      book.reduceDisplayed(maker, quantity)
      this.#applyFill(r.accountId, r.side, quantity)
      this.#applyFill(maker.request.accountId, opposite(r.side), quantity)
      this.#lastTradePrice = price

      if (maker.remaining === 0n) {
        book.remove(maker)
        this.#index.delete(maker.request.id)
      } else if (maker.displayed === 0n) {
        const slice = minOf(maker.request.displayQuantity!, maker.remaining)
        book.moveToBack(maker, this.#sequence++, slice)
      }
    }

    return { trades, cancelled, remaining, stoppedByStp }
  }

  #runTriggerCascade(): {
    trades: Trade[]
    cancelled: OrderId[]
    outcomes: Map<OrderId, SubmitResult['outcome']>
  } {
    const trades: Trade[] = []
    const cancelled: OrderId[] = []
    const fired: Executed[] = []

    // In rounds: every stop due now, in sequence order, before any stop that
    // this round's trades make due.
    for (;;) {
      const last = this.#lastTradePrice
      if (last === null) break

      const ready = [...this.#stops.values()]
        .filter((s) => triggers(s.request, last))
        .sort((a, b) => a.sequence - b.sequence)
      if (ready.length === 0) break

      for (const stop of ready) this.#stops.delete(stop.request.id)

      for (const stop of ready) {
        const isMarket = stop.request.type === 'stop_market'
        const converted: OrderRequest = {
          ...stop.request,
          type: isMarket ? 'market' : 'limit',
          price: isMarket ? null : stop.request.price,
          triggerPrice: null,
        }
        const own = this.#execute(converted)
        trades.push(...own.result.trades)
        cancelled.push(...own.result.cancelled)
        fired.push(own)
      }
    }

    const outcomes = new Map<OrderId, SubmitResult['outcome']>()
    for (const own of fired) outcomes.set(own.result.orderId, this.#outcomeNow(own))
    return { trades, cancelled, outcomes }
  }

  #applyFill(accountId: AccountId, side: Side, quantity: Lots): void {
    const signed = side === 'buy' ? quantity : -quantity
    this.#positions.set(accountId, this.position(accountId) + signed)
  }
}

// ------------------------------------------------------------------ helpers

function reject(orderId: OrderId, reason: RejectReason): SubmitResult {
  return { orderId, outcome: { kind: 'rejected', reason }, trades: [], cancelled: [] }
}

function crosses(taker: OrderRequest, makerPrice: Ticks): boolean {
  if (taker.type === 'market') return true
  const limit = taker.price!
  return taker.side === 'buy' ? makerPrice <= limit : makerPrice >= limit
}

function triggers(r: OrderRequest, lastTradePrice: Ticks): boolean {
  const trigger = r.triggerPrice!
  return r.side === 'buy' ? lastTradePrice >= trigger : lastTradePrice <= trigger
}

function levelsOf(book: BookSide): BookLevel[] {
  return book.prices().map((price) => {
    const level = book.level(price)!
    return { price, quantity: level.displayedTotal, orderCount: level.orderCount }
  })
}

function freeze(node: Node): RestingOrder {
  return {
    request: node.request,
    sequence: node.sequence,
    remaining: node.remaining,
    displayed: node.displayed,
  }
}

const minOf = (a: bigint, b: bigint): bigint => (a < b ? a : b)
