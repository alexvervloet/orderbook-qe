/**
 * Offchain and onchain agreement.
 *
 * The same order sequence is driven through the TypeScript matching engine and
 * through the Solidity contract, and the resulting books and balances are
 * compared. This is the differential technique again, across the boundary that
 * matters most on this platform: two independently written matching
 * implementations, in two languages, on two execution models.
 *
 * The offchain engine is restricted to the subset the contract implements,
 * good-till-cancelled limit orders, because comparing a stop cascade against a
 * contract with no stops would only prove the contract has no stops.
 */
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ProductionMatchingEngine } from '../../../sut/backend/engine/matching-engine.ts'
import { Ledger, type Market } from '../../../sut/backend/ledger.ts'
import {
  deployExchange,
  ONCHAIN_MARKET,
  type MarketParams,
  type OnchainExchange,
} from '../../framework/onchain-exchange.ts'
import type { OrderRequest } from '../../../spec/types.ts'

const MARKET: Market = { symbol: 'ETH-USDC', ...ONCHAIN_MARKET }

/**
 * A market whose fees do not divide evenly.
 *
 * With quoteScale 10,000 against a 10,000 basis-point denominator, every fee
 * lands on a whole unit and the rounding direction is unobservable: a mutant
 * that rounded fees down instead of up passed the entire consistency suite.
 * A quoteScale of 3 makes the remainder real, so the two implementations have
 * to agree on which way it goes. See LESSONS.md.
 */
const AWKWARD_MARKET: MarketParams = {
  quoteScale: 3n,
  baseScale: 1_000_000n,
  makerFeeBps: 2n,
  takerFeeBps: 7n,
}
const FUND_BASE = 10n ** 24n
const FUND_QUOTE = FUND_BASE * 10n ** 6n

let onchain: OnchainExchange

beforeAll(async () => {
  onchain = await deployExchange(FUND_BASE)
}, 60_000)

afterAll(async () => {
  await onchain?.stop()
})

interface Action {
  readonly trader: number
  readonly isBuy: boolean
  readonly price: bigint
  readonly quantity: bigint
}

/** Build the offchain equivalent of an onchain limit order. */
function asOrderRequest(action: Action, index: number): OrderRequest {
  return {
    id: `o${index}`,
    accountId: `t${action.trader}`,
    side: action.isBuy ? 'buy' : 'sell',
    type: 'limit',
    tif: 'GTC',
    price: action.price,
    quantity: action.quantity,
    displayQuantity: null,
    postOnly: false,
    reduceOnly: false,
    triggerPrice: null,
    stpMode: 'none',
  }
}

/** Depth from the offchain engine in the same shape the contract reports. */
function offchainDepth(engine: ProductionMatchingEngine, isBuy: boolean) {
  const { bids, asks } = engine.snapshot()
  return (isBuy ? bids : asks).map((l) => ({ price: l.price, quantity: l.quantity }))
}

async function runBothAndCompare(
  actions: readonly Action[],
  exchange: OnchainExchange = onchain,
  market: Market = MARKET,
): Promise<void> {
  const snapshot = await exchange.chain.snapshot()
  try {
    const engine = new ProductionMatchingEngine()
    const ledger = new Ledger(market)
    for (let i = 0; i < exchange.traders.length; i++) {
      ledger.deposit(`t${i}`, FUND_BASE, FUND_QUOTE)
    }

    for (const [index, action] of actions.entries()) {
      const result = engine.submit(asOrderRequest(action, index))
      for (const trade of result.trades) ledger.settle(trade)
      await exchange.placeLimitOrder(action.trader, action.isBuy, action.price, action.quantity)
    }

    // Visible depth must match level for level, on both sides.
    for (const isBuy of [true, false]) {
      expect(await exchange.depth(isBuy)).toEqual(offchainDepth(engine, isBuy))
    }

    // Every trader's holdings of both assets must match, to the unit.
    //
    // Quote is the assertion that earns its place. Base alone cannot see an
    // execution price at all: a fill of five lots moves five lots of base
    // whether it printed at 101 or at 105. An engine mutant that paid the
    // taker's limit instead of the maker's price passed this suite until quote
    // was compared as well. See LESSONS.md.
    //
    // Onchain a trader's holdings are split between available and escrowed,
    // and offchain nothing is escrowed, so the comparison is against the sum.
    for (let i = 0; i < exchange.traders.length; i++) {
      const address = exchange.traders[i]!
      const onchainBase =
        (await exchange.availableBase(address)) + (await exchange.lockedBase(address))
      const onchainQuote =
        (await exchange.availableQuote(address)) + (await exchange.lockedQuote(address))

      expect(onchainBase, `base for trader ${i}`).toBe(ledger.baseOf(`t${i}`))
      expect(onchainQuote, `quote for trader ${i}`).toBe(ledger.quoteOf(`t${i}`))
    }

    // Fees collected must match too, which catches a fee charged at the wrong
    // rate or to the wrong side even when the traders' totals happen to net out.
    expect(await exchange.availableQuote(exchange.feeRecipient)).toBe(ledger.feesCollected())
  } finally {
    await exchange.chain.revert(snapshot)
  }
}

describe('the contract and the engine agree', () => {
  it('on a simple crossing trade', async () => {
    await runBothAndCompare([
      { trader: 1, isBuy: false, price: 101n, quantity: 5n },
      { trader: 0, isBuy: true, price: 101n, quantity: 5n },
    ])
  })

  it('on price improvement for the taker', async () => {
    await runBothAndCompare([
      { trader: 1, isBuy: false, price: 101n, quantity: 5n },
      { trader: 0, isBuy: true, price: 105n, quantity: 5n },
    ])
  })

  it('on partial fills leaving a remainder resting', async () => {
    await runBothAndCompare([
      { trader: 1, isBuy: false, price: 101n, quantity: 2n },
      { trader: 0, isBuy: true, price: 101n, quantity: 7n },
    ])
  })

  it('on a multi-level sweep', async () => {
    await runBothAndCompare([
      { trader: 1, isBuy: false, price: 101n, quantity: 2n },
      { trader: 2, isBuy: false, price: 102n, quantity: 2n },
      { trader: 1, isBuy: false, price: 103n, quantity: 2n },
      { trader: 0, isBuy: true, price: 103n, quantity: 5n },
    ])
  })

  it('on queue order within a price level', async () => {
    await runBothAndCompare([
      { trader: 1, isBuy: false, price: 101n, quantity: 2n },
      { trader: 2, isBuy: false, price: 101n, quantity: 2n },
      { trader: 0, isBuy: true, price: 101n, quantity: 3n },
    ])
  })

  it('on an uncrossed book with both sides resting', async () => {
    await runBothAndCompare([
      { trader: 0, isBuy: true, price: 99n, quantity: 4n },
      { trader: 1, isBuy: false, price: 103n, quantity: 4n },
    ])
  })

  it('over random sessions', async () => {
    const action = fc.record({
      trader: fc.integer({ min: 0, max: 2 }),
      isBuy: fc.boolean(),
      price: fc.integer({ min: 98, max: 103 }).map(BigInt),
      quantity: fc.integer({ min: 1, max: 6 }).map(BigInt),
    })

    // Deliberately few runs. Every action is a real transaction on a real
    // chain, so this suite is a nightly job, not a pull request check.
    // See docs/CI-POLICY.md.
    await fc.assert(
      fc.asyncProperty(fc.array(action, { minLength: 4, maxLength: 10, size: 'max' }), (actions) =>
        runBothAndCompare(actions),
      ),
      { numRuns: Number(process.env.CONSISTENCY_RUNS ?? 5) },
    )
  }, 120_000)
})

describe('the contract and the engine agree on fee rounding', () => {
  let awkward: OnchainExchange
  const awkwardMarket: Market = { symbol: 'ODD-USDC', ...AWKWARD_MARKET }

  beforeAll(async () => {
    awkward = await deployExchange(FUND_BASE, AWKWARD_MARKET)
  }, 60_000)
  afterAll(async () => {
    await awkward?.stop()
  })

  it('when the fee does not divide evenly', async () => {
    // 7 lots at 101 ticks with quoteScale 3 is a notional of 2121, and 7 basis
    // points of that is 1.4847 units. Somebody has to decide where that goes.
    await runBothAndCompare(
      [
        { trader: 1, isBuy: false, price: 101n, quantity: 7n },
        { trader: 0, isBuy: true, price: 101n, quantity: 7n },
      ],
      awkward,
      awkwardMarket,
    )
  })

  it('over random sessions with an awkward scale', async () => {
    const action = fc.record({
      trader: fc.integer({ min: 0, max: 2 }),
      isBuy: fc.boolean(),
      price: fc.integer({ min: 98, max: 103 }).map(BigInt),
      quantity: fc.integer({ min: 1, max: 9 }).map(BigInt),
    })
    await fc.assert(
      fc.asyncProperty(fc.array(action, { minLength: 4, maxLength: 8, size: 'max' }), (actions) =>
        runBothAndCompare(actions, awkward, awkwardMarket),
      ),
      { numRuns: Number(process.env.CONSISTENCY_RUNS ?? 5) },
    )
  }, 120_000)
})
