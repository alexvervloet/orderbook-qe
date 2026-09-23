/**
 * The reference matching engine. The oracle.
 *
 * This implementation is deliberately slow and deliberately obvious. The book
 * is a flat array that gets re-sorted on every access. There is no index, no
 * price-level map, no incremental maintenance of anything. Every operation is a
 * linear scan or a sort.
 *
 * That is the whole point. It exists to be read and agreed with, line by line,
 * against spec/SEMANTICS.md. It is never going to serve a trade. The engine in
 * sut/backend is the one with the data structures, and the differential test
 * exists to catch the moment those data structures stop agreeing with this file.
 *
 * Rule for maintaining it: if a change here makes it faster, revert the change.
 */
import type { MatchingEngine } from '../../spec/engine.ts'
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
} from '../../spec/types.ts'

/** Mutable twin of RestingOrder. The public interface hands out frozen copies. */
interface Entry {
  request: OrderRequest
  sequence: Sequence
  remaining: Lots
  displayed: Lots
}

export class ReferenceEngine implements MatchingEngine {
  #book: Entry[] = []
  #stops: Entry[] = []
  #knownIds = new Set<OrderId>()
  #positions = new Map<AccountId, Lots>()
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
    const fromBook = this.#book.findIndex((e) => e.request.id === orderId)
    if (fromBook >= 0) {
      const entry = this.#book[fromBook]!
      this.#book.splice(fromBook, 1)
      return { orderId, cancelled: true, remainingAtCancel: entry.remaining }
    }
    const fromStops = this.#stops.findIndex((e) => e.request.id === orderId)
    if (fromStops >= 0) {
      const entry = this.#stops[fromStops]!
      this.#stops.splice(fromStops, 1)
      return { orderId, cancelled: true, remainingAtCancel: entry.remaining }
    }
    // Unknown, already filled, or already cancelled. All the same, all fine.
    return { orderId, cancelled: false, remainingAtCancel: 0n }
  }

  snapshot(): BookSnapshot {
    return {
      bids: aggregate(this.#sorted('buy')),
      asks: aggregate(this.#sorted('sell')),
    }
  }

  restingOrders(): readonly RestingOrder[] {
    // All bids in priority order, then all asks in priority order. The order is
    // total and deterministic, so the two engines can be compared element by
    // element rather than as sets.
    return [...this.#sorted('buy'), ...this.#sorted('sell')].map(freeze)
  }

  pendingStops(): readonly RestingOrder[] {
    return [...this.#stops].sort((a, b) => a.sequence - b.sequence).map(freeze)
  }

  lastTradePrice(): Ticks | null {
    return this.#lastTradePrice
  }

  position(accountId: AccountId): Lots {
    return this.#positions.get(accountId) ?? 0n
  }

  // --------------------------------------------------------------- private

  #validate(r: OrderRequest): RejectReason | null {
    // Order matters. SEMANTICS.md section 12 fixes it so that an order with
    // several problems always reports the same one.
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
    const entry: Entry = {
      request,
      sequence: this.#sequence++,
      remaining: request.quantity,
      displayed: request.displayQuantity ?? request.quantity,
    }
    this.#stops.push(entry)

    // A stop whose condition is already met by the current last trade price
    // fires now rather than waiting for the next trade. SEMANTICS.md section 9.
    const cascade = this.#runTriggerCascade()
    return {
      orderId: request.id,
      outcome: cascade.outcomes.get(request.id) ?? { kind: 'triggered_later' },
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
   * Match one order and rest whatever may rest. Never runs the trigger cascade.
   *
   * The order is finished, remainder resting, before any stop it triggered gets
   * to run. Letting a triggered stop go first let it rest on the far side, and
   * the remainder then rested straight through it: a crossed book. The
   * differential test never saw it, because this file had the same bug.
   * SEMANTICS.md section 9.
   */
  #execute(request: OrderRequest): { result: SubmitResult; rested: Entry | null } {
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

    // Anything that cannot rest is cancelled: IOC, FOK, and market orders,
    // which are treated as IOC no matter what TIF they arrived with. A FOK only
    // gets here when STP cut it short after it passed the fillability check.
    // SEMANTICS.md section 4.
    const canRest =
      effective.tif === 'GTC' && effective.type === 'limit' && !run.stoppedByStp
    if (!canRest) {
      return {
        result: done({ kind: 'partially_filled_and_cancelled', unfilled: run.remaining }),
        rested: null,
      }
    }

    const entry: Entry = {
      request: effective,
      sequence: this.#sequence++,
      remaining: run.remaining,
      displayed: min(effective.displayQuantity ?? run.remaining, run.remaining),
    }
    this.#book.push(entry)
    return { result: done({ kind: 'resting', remaining: run.remaining }), rested: entry }
  }

  /**
   * The order's outcome as it stands when submit returns.
   *
   * A resting order can be filled, or cancelled by self-trade prevention, by a
   * stop it triggered itself. Reporting the state at the moment it rested would
   * tell the client about an order that no longer exists.
   */
  #outcomeNow(own: { result: SubmitResult; rested: Entry | null }): SubmitResult['outcome'] {
    const entry = own.rested
    if (entry === null) return own.result.outcome
    if (this.#book.includes(entry)) return { kind: 'resting', remaining: entry.remaining }
    if (entry.remaining === 0n) return { kind: 'filled' }
    return { kind: 'partially_filled_and_cancelled', unfilled: entry.remaining }
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

    const cap = abs(position)
    if (r.quantity <= cap) return { request: r }
    return { request: { ...r, quantity: cap } }
  }

  /** Price-eligible resting orders on the other side, best first. */
  #crossable(r: OrderRequest): Entry[] {
    const other = opposite(r.side)
    return this.#sorted(other).filter((e) => priceCrosses(r, e.request.price!))
  }

  #wouldCross(r: OrderRequest): boolean {
    return this.#crossable(r).length > 0
  }

  #fillableQuantity(r: OrderRequest): Lots {
    return this.#crossable(r).reduce((sum, e) => sum + e.displayed, 0n)
  }

  #match(r: OrderRequest): {
    trades: Trade[]
    cancelled: OrderId[]
    remaining: Lots
    stoppedByStp: boolean
  } {
    const trades: Trade[] = []
    const cancelled: OrderId[] = []
    let remaining = r.quantity
    let stoppedByStp = false

    while (remaining > 0n) {
      const candidates = this.#crossable(r)
      const maker = candidates[0]
      if (maker === undefined) break

      if (maker.request.accountId === r.accountId && r.stpMode !== 'none') {
        if (r.stpMode === 'cancel_taker') {
          stoppedByStp = true
          break
        }
        this.#remove(maker)
        cancelled.push(maker.request.id)
        if (r.stpMode === 'cancel_both') {
          stoppedByStp = true
          break
        }
        continue // cancel_maker: keep going against the next resting order
      }

      const quantity = min(remaining, maker.displayed)
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
      maker.displayed -= quantity
      this.#applyFill(r.accountId, r.side, quantity)
      this.#applyFill(maker.request.accountId, opposite(r.side), quantity)
      this.#lastTradePrice = price

      if (maker.remaining === 0n) {
        this.#remove(maker)
      } else if (maker.displayed === 0n) {
        // Iceberg refresh. A new slice goes to the back of its price level,
        // which a fresh sequence number expresses. SEMANTICS.md section 8.
        maker.displayed = min(maker.request.displayQuantity!, maker.remaining)
        maker.sequence = this.#sequence++
      }
    }

    return { trades, cancelled, remaining, stoppedByStp }
  }

  /**
   * Fire every stop the last trade price has reached, in rounds.
   *
   * A round takes every waiting stop that is due, in ascending sequence, and
   * runs each one to completion. Stops that trades in the round made due wait
   * for the next round. No stop starts a cascade of its own, so a stop triggered
   * later never jumps ahead of one triggered earlier. SEMANTICS.md section 9.
   */
  #runTriggerCascade(): {
    trades: Trade[]
    cancelled: OrderId[]
    outcomes: Map<OrderId, SubmitResult['outcome']>
  } {
    const trades: Trade[] = []
    const cancelled: OrderId[] = []
    const fired: { result: SubmitResult; rested: Entry | null }[] = []

    for (;;) {
      const last = this.#lastTradePrice
      if (last === null) break

      const ready = this.#stops
        .filter((e) => stopTriggers(e.request, last))
        .sort((a, b) => a.sequence - b.sequence)
      if (ready.length === 0) break

      for (const entry of ready) {
        const index = this.#stops.indexOf(entry)
        if (index >= 0) this.#stops.splice(index, 1)
      }

      for (const entry of ready) {
        const converted: OrderRequest = {
          ...entry.request,
          type: entry.request.type === 'stop_market' ? 'market' : 'limit',
          price: entry.request.type === 'stop_market' ? null : entry.request.price,
          triggerPrice: null,
        }
        // The id is already registered, so skip validation.
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

  #remove(entry: Entry): void {
    const index = this.#book.indexOf(entry)
    if (index >= 0) this.#book.splice(index, 1)
  }

  /** Re-sorted on every call, on purpose. */
  #sorted(side: Side): Entry[] {
    return this.#book
      .filter((e) => e.request.side === side)
      .sort((a, b) => {
        const pa = a.request.price!
        const pb = b.request.price!
        if (pa !== pb) return side === 'buy' ? cmpDesc(pa, pb) : cmpAsc(pa, pb)
        return a.sequence - b.sequence
      })
  }
}

// ------------------------------------------------------------------ helpers

function reject(orderId: OrderId, reason: RejectReason): SubmitResult {
  return { orderId, outcome: { kind: 'rejected', reason }, trades: [], cancelled: [] }
}

function priceCrosses(taker: OrderRequest, makerPrice: Ticks): boolean {
  if (taker.type === 'market') return true
  const limit = taker.price!
  return taker.side === 'buy' ? makerPrice <= limit : makerPrice >= limit
}

function stopTriggers(r: OrderRequest, lastTradePrice: Ticks): boolean {
  const trigger = r.triggerPrice!
  return r.side === 'buy' ? lastTradePrice >= trigger : lastTradePrice <= trigger
}

function aggregate(entries: Entry[]): BookLevel[] {
  const levels: BookLevel[] = []
  for (const entry of entries) {
    const price = entry.request.price!
    const last = levels.at(-1)
    if (last !== undefined && last.price === price) {
      levels[levels.length - 1] = {
        price,
        quantity: last.quantity + entry.displayed,
        orderCount: last.orderCount + 1,
      }
    } else {
      levels.push({ price, quantity: entry.displayed, orderCount: 1 })
    }
  }
  return levels
}

function freeze(entry: Entry): RestingOrder {
  return {
    request: entry.request,
    sequence: entry.sequence,
    remaining: entry.remaining,
    displayed: entry.displayed,
  }
}

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b)
const abs = (a: bigint): bigint => (a < 0n ? -a : a)
const cmpAsc = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0)
const cmpDesc = (a: bigint, b: bigint): number => -cmpAsc(a, b)
