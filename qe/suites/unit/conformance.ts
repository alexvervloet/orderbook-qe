/**
 * The conformance suite. Every matching engine in this repo runs it.
 *
 * Each block cites the section of spec/SEMANTICS.md it enforces. The expected
 * values come from that document, not from running either engine and recording
 * what came out. When a test here fails, the first question is which of the two
 * is wrong: the engine, or the spec.
 *
 * Parameterised by a factory so the reference engine and the production engine
 * are held to exactly the same bar, from the same source text.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import type { MatchingEngine } from '../../../spec/engine.ts'
import type { SubmitResult, Trade } from '../../../spec/types.ts'
import {
  buy,
  marketBuy,
  resetOrderIds,
  sell,
  stopLimit,
  stopMarket,
} from '../../framework/orders.ts'

type Factory = () => MatchingEngine

const priced = (trades: readonly Trade[]): [bigint, bigint][] =>
  trades.map((t) => [t.price, t.quantity])

const rejection = (r: SubmitResult): string =>
  r.outcome.kind === 'rejected' ? r.outcome.reason : `not rejected: ${r.outcome.kind}`

export function describeMatchingEngine(name: string, create: Factory): void {
  describe(name, () => {
    let engine: MatchingEngine
    beforeEach(() => {
      resetOrderIds()
      engine = create()
    })

    // ---------------------------------------------------- section 2, priority
    describe('price-time priority', () => {
      it('fills the better price first regardless of arrival order', () => {
        engine.submit(sell(102n, 1n, { id: 'expensive', accountId: 'maker1' }))
        engine.submit(sell(101n, 1n, { id: 'cheap', accountId: 'maker2' }))

        const result = engine.submit(buy(105n, 1n, { accountId: 'taker' }))

        expect(result.trades).toHaveLength(1)
        expect(result.trades[0]!.makerOrderId).toBe('cheap')
      })

      it('fills the earlier order first within one price level', () => {
        engine.submit(sell(101n, 1n, { id: 'first', accountId: 'maker1' }))
        engine.submit(sell(101n, 1n, { id: 'second', accountId: 'maker2' }))

        const result = engine.submit(buy(101n, 2n, { accountId: 'taker' }))

        expect(result.trades.map((t) => t.makerOrderId)).toEqual(['first', 'second'])
      })

      it('leaves the book uncrossed at rest', () => {
        engine.submit(buy(100n, 1n, { accountId: 'a' }))
        engine.submit(sell(101n, 1n, { accountId: 'b' }))

        const { bids, asks } = engine.snapshot()
        expect(bids[0]!.price).toBeLessThan(asks[0]!.price)
      })
    })

    // ------------------------------------------- section 3, execution price
    describe('execution price', () => {
      it('trades at the resting maker price, giving the taker the improvement', () => {
        engine.submit(sell(101n, 1n, { accountId: 'maker' }))

        const result = engine.submit(buy(105n, 1n, { accountId: 'taker' }))

        expect(result.trades[0]!.price).toBe(101n)
      })

      it('walks several levels and prices each fill at its own maker', () => {
        engine.submit(sell(101n, 2n, { accountId: 'm1' }))
        engine.submit(sell(103n, 2n, { accountId: 'm2' }))

        const result = engine.submit(buy(105n, 3n, { accountId: 'taker' }))

        expect(priced(result.trades)).toEqual([
          [101n, 2n],
          [103n, 1n],
        ])
      })
    })

    // ----------------------------------------------- section 4, time in force
    describe('time in force', () => {
      it('rests the remainder of a GTC order', () => {
        engine.submit(sell(101n, 1n, { accountId: 'maker' }))

        const result = engine.submit(buy(101n, 3n, { accountId: 'taker' }))

        expect(result.outcome).toEqual({ kind: 'resting', remaining: 2n })
        expect(engine.snapshot().bids[0]).toEqual({ price: 101n, quantity: 2n, orderCount: 1 })
      })

      it('cancels the remainder of an IOC order instead of resting it', () => {
        engine.submit(sell(101n, 1n, { accountId: 'maker' }))

        const result = engine.submit(buy(101n, 3n, { accountId: 'taker', tif: 'IOC' }))

        expect(result.outcome).toEqual({ kind: 'partially_filled_and_cancelled', unfilled: 2n })
        expect(engine.snapshot().bids).toEqual([])
      })

      it('treats a completely unfilled IOC as a cancel, not a rejection', () => {
        const result = engine.submit(buy(101n, 3n, { accountId: 'taker', tif: 'IOC' }))

        expect(result.outcome.kind).toBe('partially_filled_and_cancelled')
        expect(result.trades).toEqual([])
      })

      it('rejects a FOK that cannot fill completely, leaving no trace', () => {
        engine.submit(sell(101n, 1n, { accountId: 'maker' }))

        const result = engine.submit(buy(101n, 3n, { accountId: 'taker', tif: 'FOK' }))

        expect(rejection(result)).toBe('fok_not_fully_fillable')
        expect(result.trades).toEqual([])
        // The liquidity it could have taken is untouched.
        expect(engine.snapshot().asks[0]!.quantity).toBe(1n)
      })

      it('fills a FOK that can fill completely across levels', () => {
        engine.submit(sell(101n, 1n, { accountId: 'm1' }))
        engine.submit(sell(102n, 2n, { accountId: 'm2' }))

        const result = engine.submit(buy(102n, 3n, { accountId: 'taker', tif: 'FOK' }))

        expect(result.outcome).toEqual({ kind: 'filled' })
        expect(priced(result.trades)).toEqual([
          [101n, 1n],
          [102n, 2n],
        ])
      })

      it('does not count liquidity priced beyond the limit toward FOK fillability', () => {
        // One lot is reachable at 101. Five more sit at 110, past the limit.
        // A FOK for three lots must be rejected on the one reachable lot alone.
        // Added after a mutant that deleted the price guard in the fillability
        // scan survived all 104 unit tests. See LESSONS.md.
        engine.submit(sell(101n, 1n, { accountId: 'm1' }))
        engine.submit(sell(110n, 5n, { accountId: 'm2' }))

        const result = engine.submit(buy(101n, 3n, { accountId: 'taker', tif: 'FOK' }))

        expect(rejection(result)).toBe('fok_not_fully_fillable')
        expect(result.trades).toEqual([])
      })

      it('does not count hidden iceberg size toward FOK fillability', () => {
        // Ten lots are resting but only two are displayed.
        engine.submit(sell(101n, 10n, { accountId: 'maker', displayQuantity: 2n }))

        const result = engine.submit(buy(101n, 5n, { accountId: 'taker', tif: 'FOK' }))

        expect(rejection(result)).toBe('fok_not_fully_fillable')
      })
    })

    // ------------------------------------------------ section 5, order types
    describe('market orders', () => {
      it('sweeps the book without a price limit', () => {
        engine.submit(sell(101n, 1n, { accountId: 'm1' }))
        engine.submit(sell(900n, 1n, { accountId: 'm2' }))

        const result = engine.submit(marketBuy(2n, { accountId: 'taker' }))

        expect(priced(result.trades)).toEqual([
          [101n, 1n],
          [900n, 1n],
        ])
      })

      it('produces nothing against an empty book and is not an error', () => {
        const result = engine.submit(marketBuy(2n, { accountId: 'taker' }))

        expect(result.trades).toEqual([])
        expect(result.outcome.kind).toBe('partially_filled_and_cancelled')
      })

      it('never rests, even when submitted as GTC', () => {
        engine.submit(sell(101n, 1n, { accountId: 'maker' }))

        engine.submit(marketBuy(5n, { accountId: 'taker', tif: 'GTC' }))

        expect(engine.snapshot().bids).toEqual([])
      })

      it('rejects a market order carrying a price', () => {
        const result = engine.submit(marketBuy(1n, { accountId: 'taker', price: 100n }))

        expect(rejection(result)).toBe('invalid_price')
      })
    })

    // -------------------------------------------------- section 6, post-only
    describe('post-only', () => {
      it('rejects an order that would take liquidity', () => {
        engine.submit(sell(101n, 1n, { accountId: 'maker' }))

        const result = engine.submit(buy(101n, 1n, { accountId: 'taker', postOnly: true }))

        expect(rejection(result)).toBe('post_only_would_cross')
        expect(result.trades).toEqual([])
      })

      it('rests an order that does not cross', () => {
        engine.submit(sell(102n, 1n, { accountId: 'maker' }))

        const result = engine.submit(buy(101n, 1n, { accountId: 'taker', postOnly: true }))

        expect(result.outcome).toEqual({ kind: 'resting', remaining: 1n })
      })

      it('rejects on would-cross even when the only liquidity is the same account', () => {
        engine.submit(sell(101n, 1n, { accountId: 'alice' }))

        const result = engine.submit(
          buy(101n, 1n, { accountId: 'alice', postOnly: true, stpMode: 'cancel_maker' }),
        )

        expect(rejection(result)).toBe('post_only_would_cross')
      })
    })

    // --------------------------------------- section 7, self-trade prevention
    describe('self-trade prevention', () => {
      it('allows a self trade when the mode is none', () => {
        engine.submit(sell(101n, 1n, { accountId: 'alice' }))

        const result = engine.submit(buy(101n, 1n, { accountId: 'alice', stpMode: 'none' }))

        expect(result.trades).toHaveLength(1)
      })

      it('cancel_taker stops the taker and leaves the maker resting', () => {
        engine.submit(sell(101n, 1n, { id: 'mine', accountId: 'alice' }))

        const result = engine.submit(
          buy(101n, 1n, { accountId: 'alice', stpMode: 'cancel_taker' }),
        )

        expect(result.trades).toEqual([])
        expect(engine.snapshot().asks[0]!.quantity).toBe(1n)
        // Stopped means stopped: the remainder is cancelled, not rested.
        expect(result.outcome).toEqual({ kind: 'partially_filled_and_cancelled', unfilled: 1n })
        expect(engine.snapshot().bids).toEqual([])
      })

      it('cancel_taker keeps trades already made against other accounts', () => {
        engine.submit(sell(101n, 1n, { id: 'theirs', accountId: 'bob' }))
        engine.submit(sell(102n, 1n, { id: 'mine', accountId: 'alice' }))

        const result = engine.submit(
          buy(102n, 2n, { accountId: 'alice', stpMode: 'cancel_taker' }),
        )

        expect(result.trades).toHaveLength(1)
        expect(result.trades[0]!.makerOrderId).toBe('theirs')
        expect(result.outcome).toEqual({ kind: 'partially_filled_and_cancelled', unfilled: 1n })
        expect(engine.snapshot().bids).toEqual([])
      })

      it('cancel_maker removes the resting order and carries on matching', () => {
        engine.submit(sell(101n, 1n, { id: 'mine', accountId: 'alice' }))
        engine.submit(sell(102n, 1n, { id: 'theirs', accountId: 'bob' }))

        const result = engine.submit(
          buy(102n, 1n, { accountId: 'alice', stpMode: 'cancel_maker' }),
        )

        expect(result.cancelled).toEqual(['mine'])
        expect(result.trades[0]!.makerOrderId).toBe('theirs')
      })

      it('cancel_both removes the maker and stops the taker', () => {
        engine.submit(sell(101n, 1n, { id: 'mine', accountId: 'alice' }))
        engine.submit(sell(102n, 1n, { id: 'theirs', accountId: 'bob' }))

        const result = engine.submit(
          buy(102n, 2n, { accountId: 'alice', stpMode: 'cancel_both' }),
        )

        expect(result.cancelled).toEqual(['mine'])
        expect(result.trades).toEqual([])
        // Bob's order is untouched.
        expect(engine.snapshot().asks).toHaveLength(1)
        // And the taker went nowhere. A GTC remainder resting at 102 here
        // would sit level with Bob's ask.
        expect(result.outcome).toEqual({ kind: 'partially_filled_and_cancelled', unfilled: 2n })
        expect(engine.snapshot().bids).toEqual([])
      })
    })

    // ---------------------------------------------------- section 8, iceberg
    describe('iceberg orders', () => {
      it('shows only the display quantity in the book', () => {
        engine.submit(sell(101n, 10n, { accountId: 'maker', displayQuantity: 2n }))

        expect(engine.snapshot().asks[0]!.quantity).toBe(2n)
      })

      it('refreshes a new slice after the displayed part is consumed', () => {
        engine.submit(sell(101n, 10n, { accountId: 'maker', displayQuantity: 2n }))

        engine.submit(buy(101n, 2n, { accountId: 'taker' }))

        expect(engine.snapshot().asks[0]!.quantity).toBe(2n)
      })

      it('sends the refreshed slice to the back of its price level', () => {
        engine.submit(sell(101n, 10n, { id: 'iceberg', accountId: 'm1', displayQuantity: 2n }))
        engine.submit(sell(101n, 2n, { id: 'plain', accountId: 'm2' }))

        // Consume the iceberg's visible slice, forcing a refresh.
        engine.submit(buy(101n, 2n, { accountId: 't1' }))
        // The plain order queued behind it should now be served first.
        const result = engine.submit(buy(101n, 2n, { accountId: 't2' }))

        expect(result.trades.map((t) => t.makerOrderId)).toEqual(['plain'])
      })

      it('rejects a display quantity larger than the order', () => {
        const result = engine.submit(sell(101n, 2n, { accountId: 'm', displayQuantity: 3n }))

        expect(rejection(result)).toBe('invalid_display_quantity')
      })

      it('rejects a zero display quantity', () => {
        const result = engine.submit(sell(101n, 2n, { accountId: 'm', displayQuantity: 0n }))

        expect(rejection(result)).toBe('invalid_display_quantity')
      })
    })

    // ------------------------------------------------ section 9, stop orders
    describe('stop orders', () => {
      it('does not appear in the book before triggering', () => {
        engine.submit(stopMarket('buy', 105n, 1n, { accountId: 'a' }))

        expect(engine.snapshot().bids).toEqual([])
        expect(engine.pendingStops()).toHaveLength(1)
      })

      it('triggers a buy stop when the last trade reaches the trigger', () => {
        engine.submit(stopMarket('buy', 105n, 1n, { id: 'stop', accountId: 'stopper' }))
        engine.submit(sell(110n, 1n, { accountId: 'm1' })) // liquidity for the stop
        engine.submit(sell(105n, 1n, { accountId: 'm2' }))

        const result = engine.submit(buy(105n, 1n, { accountId: 'taker' }))

        // The taker trade at 105 triggers the stop, which then buys at 110.
        expect(priced(result.trades)).toEqual([
          [105n, 1n],
          [110n, 1n],
        ])
        expect(engine.pendingStops()).toEqual([])
      })

      it('does not trigger a buy stop below its trigger price', () => {
        engine.submit(stopMarket('buy', 105n, 1n, { accountId: 'stopper' }))
        engine.submit(sell(100n, 1n, { accountId: 'maker' }))

        engine.submit(buy(100n, 1n, { accountId: 'taker' }))

        expect(engine.pendingStops()).toHaveLength(1)
      })

      it('triggers immediately when the last trade price already satisfies it', () => {
        engine.submit(sell(105n, 1n, { accountId: 'm1' }))
        engine.submit(buy(105n, 1n, { accountId: 't1' })) // last trade is now 105
        engine.submit(sell(110n, 1n, { accountId: 'm2' }))

        const result = engine.submit(stopMarket('buy', 105n, 1n, { accountId: 'stopper' }))

        expect(priced(result.trades)).toEqual([[110n, 1n]])
      })

      it('converts a stop-limit into a limit order at its price', () => {
        engine.submit(stopLimit('buy', 105n, 106n, 5n, { id: 'stop', accountId: 'stopper' }))
        engine.submit(sell(105n, 1n, { accountId: 'm1' }))

        engine.submit(buy(105n, 1n, { accountId: 'taker' }))

        // Triggered, found no liquidity at or below 106, and rested as a bid.
        expect(engine.snapshot().bids[0]).toEqual({ price: 106n, quantity: 5n, orderCount: 1 })
      })

      it('cancels an untriggered stop', () => {
        engine.submit(stopMarket('buy', 105n, 1n, { id: 'stop', accountId: 'a' }))

        const result = engine.cancel('stop')

        expect(result.cancelled).toBe(true)
        expect(engine.pendingStops()).toEqual([])
      })

      it('resolves a cascade where one stop triggers another', () => {
        engine.submit(stopMarket('buy', 105n, 1n, { id: 's1', accountId: 'a' }))
        engine.submit(stopMarket('buy', 110n, 1n, { id: 's2', accountId: 'b' }))
        engine.submit(sell(110n, 1n, { accountId: 'm1' }))
        engine.submit(sell(120n, 1n, { accountId: 'm2' }))
        engine.submit(sell(105n, 1n, { accountId: 'm3' }))

        const result = engine.submit(buy(105n, 1n, { accountId: 'taker' }))

        // 105 fires s1, which buys at 110, which fires s2, which buys at 120.
        expect(priced(result.trades)).toEqual([
          [105n, 1n],
          [110n, 1n],
          [120n, 1n],
        ])
        expect(engine.pendingStops()).toEqual([])
      })

      it('rests the triggering order before the stop it triggered runs', () => {
        // Found by the book-invariant property, not by the differential test:
        // both engines let the stop rest first, then rested the taker through
        // it, leaving a bid at 105 over an ask at 104.
        engine.submit(sell(100n, 5n, { accountId: 'maker' }))
        engine.submit(stopLimit('sell', 100n, 104n, 3n, { accountId: 'stopper' }))

        const result = engine.submit(buy(105n, 10n, { id: 'taker', accountId: 'taker' }))

        // The taker rests 5 at 105, then the stop sells into it at the maker price.
        expect(priced(result.trades)).toEqual([
          [100n, 5n],
          [105n, 3n],
        ])
        expect(engine.snapshot()).toEqual({
          bids: [{ price: 105n, quantity: 2n, orderCount: 1 }],
          asks: [],
        })
      })

      it('reports the outcome after the stops it triggered, not when it rested', () => {
        engine.submit(sell(100n, 5n, { accountId: 'maker' }))
        engine.submit(stopLimit('sell', 100n, 104n, 5n, { accountId: 'stopper' }))

        const result = engine.submit(buy(105n, 10n, { accountId: 'taker' }))

        // It rested 5, and the stop it fired then sold into all 5. Telling
        // the client "resting 5" would describe an order that no longer exists.
        expect(result.outcome).toEqual({ kind: 'filled' })
        expect(engine.snapshot()).toEqual({ bids: [], asks: [] })
      })

      it('fires stops in rounds, so a later trigger never jumps the queue', () => {
        engine.submit(sell(100n, 1n, { accountId: 'm' }))
        engine.submit(sell(110n, 1n, { accountId: 'm' }))
        engine.submit(sell(120n, 10n, { accountId: 'm' }))
        engine.submit(stopMarket('buy', 100n, 1n, { id: 'S1', accountId: 'p' }))
        engine.submit(stopMarket('buy', 100n, 1n, { id: 'S2', accountId: 'q' }))
        engine.submit(stopMarket('buy', 110n, 1n, { id: 'S3', accountId: 'r' }))

        const result = engine.submit(marketBuy(1n, { id: 'T', accountId: 't' }))

        // S1 and S2 are both due at 100. S1's fill at 110 makes S3 due, but S3
        // waits for the next round, behind S2. SEMANTICS.md section 9.
        expect(result.trades.map((t) => t.takerOrderId)).toEqual(['T', 'S1', 'S2', 'S3'])
      })
    })

    // ------------------------------------------------ section 10, reduce-only
    describe('reduce-only', () => {
      const openLong = (): void => {
        engine.submit(sell(100n, 5n, { accountId: 'counterparty' }))
        engine.submit(buy(100n, 5n, { accountId: 'alice' }))
      }

      it('rejects when the account has no position', () => {
        const result = engine.submit(sell(100n, 1n, { accountId: 'alice', reduceOnly: true }))

        expect(rejection(result)).toBe('reduce_only_no_position')
      })

      it('rejects an order on the same side as the position', () => {
        openLong()

        const result = engine.submit(buy(100n, 1n, { accountId: 'alice', reduceOnly: true }))

        expect(rejection(result)).toBe('reduce_only_wrong_side')
      })

      it('caps the quantity at the open position size', () => {
        openLong()
        engine.submit(buy(99n, 100n, { accountId: 'counterparty' }))

        const result = engine.submit(
          sell(99n, 50n, { accountId: 'alice', reduceOnly: true }),
        )

        // Long five lots, so at most five can be sold.
        expect(result.trades.reduce((sum, t) => sum + t.quantity, 0n)).toBe(5n)
        expect(engine.position('alice')).toBe(0n)
      })

      it('leaves a smaller reduce-only order alone', () => {
        openLong()
        engine.submit(buy(99n, 100n, { accountId: 'counterparty' }))

        engine.submit(sell(99n, 2n, { accountId: 'alice', reduceOnly: true }))

        expect(engine.position('alice')).toBe(3n)
      })
    })

    // ----------------------------------------------------- section 11, cancel
    describe('cancel', () => {
      it('removes a resting order', () => {
        engine.submit(buy(100n, 1n, { id: 'target', accountId: 'a' }))

        const result = engine.cancel('target')

        expect(result.cancelled).toBe(true)
        expect(result.remainingAtCancel).toBe(1n)
        expect(engine.snapshot().bids).toEqual([])
      })

      it('is idempotent', () => {
        engine.submit(buy(100n, 1n, { id: 'target', accountId: 'a' }))
        engine.cancel('target')

        const second = engine.cancel('target')

        expect(second.cancelled).toBe(false)
      })

      it('treats an unknown id as already gone rather than an error', () => {
        expect(engine.cancel('never-existed').cancelled).toBe(false)
      })

      it('never fills a cancelled order', () => {
        engine.submit(sell(100n, 1n, { id: 'target', accountId: 'a' }))
        engine.cancel('target')

        const result = engine.submit(marketBuy(1n, { accountId: 'taker' }))

        expect(result.trades).toEqual([])
      })
    })

    // ------------------------------------------------- section 12, validation
    describe('validation', () => {
      it('rejects a duplicate order id', () => {
        engine.submit(buy(100n, 1n, { id: 'dupe', accountId: 'a' }))

        const result = engine.submit(buy(101n, 1n, { id: 'dupe', accountId: 'a' }))

        expect(rejection(result)).toBe('duplicate_order_id')
      })

      it('rejects a duplicate id even after the first order is gone', () => {
        engine.submit(buy(100n, 1n, { id: 'dupe', accountId: 'a' }))
        engine.cancel('dupe')

        const result = engine.submit(buy(100n, 1n, { id: 'dupe', accountId: 'a' }))

        expect(rejection(result)).toBe('duplicate_order_id')
      })

      it('rejects zero quantity', () => {
        expect(rejection(engine.submit(buy(100n, 0n, { accountId: 'a' })))).toBe(
          'invalid_quantity',
        )
      })

      it('rejects negative quantity', () => {
        expect(rejection(engine.submit(buy(100n, -1n, { accountId: 'a' })))).toBe(
          'invalid_quantity',
        )
      })

      it('rejects a non-positive limit price', () => {
        expect(rejection(engine.submit(buy(0n, 1n, { accountId: 'a' })))).toBe('invalid_price')
      })

      it('reports the duplicate id before any other problem', () => {
        engine.submit(buy(100n, 1n, { id: 'dupe', accountId: 'a' }))

        // Both a duplicate id and a zero quantity. Section 12 fixes the order.
        const result = engine.submit(buy(100n, 0n, { id: 'dupe', accountId: 'a' }))

        expect(rejection(result)).toBe('duplicate_order_id')
      })

      it('rejects a stop order with no trigger price', () => {
        // Mutating the || in the trigger validation to && made this pass
        // validation, and a stop with a null trigger then compares a price
        // against null. Nothing covered it, because every builder supplies a
        // trigger. See docs/MUTATION.md.
        const result = engine.submit(
          stopMarket('buy', 1n, 1n, { accountId: 'a', triggerPrice: null }),
        )

        expect(rejection(result)).toBe('invalid_trigger_price')
      })

      it('rejects a stop order with a non-positive trigger price', () => {
        const result = engine.submit(stopMarket('buy', 0n, 1n, { accountId: 'a' }))

        expect(rejection(result)).toBe('invalid_trigger_price')
      })

      it('rejects a trigger price on a non-stop order', () => {
        const result = engine.submit(buy(100n, 1n, { accountId: 'a', triggerPrice: 99n }))

        expect(rejection(result)).toBe('invalid_trigger_price')
      })
    })

    // ------------------------------------------------------------- positions
    describe('positions', () => {
      it('moves both sides of a trade in opposite directions', () => {
        engine.submit(sell(100n, 3n, { accountId: 'seller' }))
        engine.submit(buy(100n, 3n, { accountId: 'buyer' }))

        expect(engine.position('buyer')).toBe(3n)
        expect(engine.position('seller')).toBe(-3n)
      })

      it('nets to zero across all accounts', () => {
        engine.submit(sell(100n, 3n, { accountId: 'a' }))
        engine.submit(buy(100n, 2n, { accountId: 'b' }))
        engine.submit(marketBuy(1n, { accountId: 'c' }))

        const total = ['a', 'b', 'c'].reduce((sum, id) => sum + engine.position(id), 0n)
        expect(total).toBe(0n)
      })
    })
  })
}
