/**
 * Chain reorganisation and recovery.
 *
 * A reorg undoes settled transactions. The offchain record does not undo
 * itself, so after a reorg the two disagree, and the only question that matters
 * is whether the platform notices.
 *
 * These tests do not assert that the exchange survives a reorg, because it
 * currently does not handle one. They assert that the reconciler detects the
 * divergence a reorg produces, which is the prerequisite for handling it and
 * the thing that must never silently fail. Asserting recovery that does not
 * exist would be writing a test for a feature and calling it coverage. See
 * docs/NON-GOALS.md.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ProductionMatchingEngine } from '../../../sut/backend/engine/matching-engine.ts'
import { Ledger, type Market } from '../../../sut/backend/ledger.ts'
import { deployExchange, ONCHAIN_MARKET, type OnchainExchange } from '../../framework/onchain-exchange.ts'
import { describeReport, reconcile } from '../../framework/reconciler.ts'
import type { OrderRequest } from '../../../spec/types.ts'

const MARKET: Market = { symbol: 'ETH-USDC', ...ONCHAIN_MARKET }
const FUND_BASE = 10n ** 24n
const FUND_QUOTE = FUND_BASE * 10n ** 6n

let onchain: OnchainExchange

beforeAll(async () => {
  onchain = await deployExchange(FUND_BASE)
}, 60_000)
afterAll(async () => {
  await onchain?.stop()
})

function accounts() {
  return onchain.traders.map((address, index) => ({ offchainId: `t${index}`, address }))
}

function fundedLedger(): Ledger {
  const ledger = new Ledger(MARKET)
  for (let i = 0; i < onchain.traders.length; i++) ledger.deposit(`t${i}`, FUND_BASE, FUND_QUOTE)
  return ledger
}

function limitOrder(trader: number, side: 'buy' | 'sell', price: bigint, quantity: bigint, id: string): OrderRequest {
  return {
    id,
    accountId: `t${trader}`,
    side,
    type: 'limit',
    tif: 'GTC',
    price,
    quantity,
    displayQuantity: null,
    postOnly: false,
    reduceOnly: false,
    triggerPrice: null,
    stpMode: 'none',
  }
}

describe('reconciliation', () => {
  it('agrees when both sides processed the same trades', async () => {
    const snapshot = await onchain.chain.snapshot()
    try {
      const engine = new ProductionMatchingEngine()
      const ledger = fundedLedger()

      for (const [index, action] of [
        { trader: 1, side: 'sell' as const, price: 101n, quantity: 4n },
        { trader: 0, side: 'buy' as const, price: 101n, quantity: 4n },
      ].entries()) {
        const order = limitOrder(action.trader, action.side, action.price, action.quantity, `o${index}`)
        for (const trade of engine.submit(order).trades) ledger.settle(trade)
        await onchain.placeLimitOrder(action.trader, action.side === 'buy', action.price, action.quantity)
      }

      const report = await reconcile(ledger, onchain, accounts())
      expect(describeReport(report)).toBe('offchain and onchain agree')
    } finally {
      await onchain.chain.revert(snapshot)
    }
  })

  it('detects the divergence a reorg leaves behind', async () => {
    const engine = new ProductionMatchingEngine()
    const ledger = fundedLedger()

    // Both sides settle the same trade.
    const maker = limitOrder(1, 'sell', 102n, 3n, 'm1')
    const taker = limitOrder(0, 'buy', 102n, 3n, 't1')
    for (const order of [maker, taker]) {
      for (const trade of engine.submit(order).trades) ledger.settle(trade)
    }
    await onchain.placeLimitOrder(1, false, 102n, 3n)

    // Snapshot after the maker rests but before the trade settles onchain,
    // then settle, then revert to the snapshot. That is a reorg: the chain
    // forgets the fill, and the offchain ledger does not.
    const beforeFill = await onchain.chain.snapshot()
    await onchain.placeLimitOrder(0, true, 102n, 3n)

    const beforeReorg = await reconcile(ledger, onchain, accounts())
    expect(beforeReorg.agreed, describeReport(beforeReorg)).toBe(true)

    await onchain.chain.revert(beforeFill)

    const afterReorg = await reconcile(ledger, onchain, accounts())
    expect(afterReorg.agreed).toBe(false)
    // The offchain side believes a trade happened that the chain no longer
    // knows about, so base moved offchain and did not move onchain.
    expect(afterReorg.divergences.length).toBeGreaterThan(0)
    expect(afterReorg.netBase).toBe(0n) // the discrepancy nets out across the two traders
    expect(afterReorg.divergences.some((d) => d.field === 'base')).toBe(true)
  })

  it('reports a divergence per account rather than stopping at the first', async () => {
    // Which accounts diverged is the difference between one bad settlement and
    // a systemic problem, so the reconciler must not stop early.
    const snapshot = await onchain.chain.snapshot()
    try {
      const ledger = fundedLedger()
      ledger.deposit('t0', 5n, 0n)
      ledger.deposit('t1', 7n, 0n)

      const report = await reconcile(ledger, onchain, accounts())

      expect(report.agreed).toBe(false)
      expect(report.divergences.map((d) => d.account).sort()).toEqual(['t0', 't1'])
      expect(report.netBase).toBe(12n)
    } finally {
      await onchain.chain.revert(snapshot)
    }
  })
})

describe('chain unavailability', () => {
  it('surfaces a failure rather than silently reporting agreement', async () => {
    const ledger = fundedLedger()
    await onchain.chain.stop()

    // A reconciler that swallows an RPC error and returns "agreed" is worse
    // than no reconciler: it manufactures confidence. This must reject.
    await expect(reconcile(ledger, onchain, accounts())).rejects.toThrow()

    // Restarting is out of scope for this file; it runs last for that reason.
  })
})
