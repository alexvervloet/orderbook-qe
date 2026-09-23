/**
 * Value conservation over random trading sessions.
 *
 * The engine produces a trade tape from a random session; the ledger settles
 * every trade in it. The assertions are the invariants in spec/LEDGER.md, and
 * they are checked after every single trade rather than at the end, so a
 * failure names the trade that broke it.
 *
 * Accounts are funded generously up front. Reservation is the risk layer's job
 * and is out of scope here, so an overdraft would be a fact about the funding
 * in this test rather than a fact about the ledger.
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  ceilDiv,
  feeOf,
  FEE_ACCOUNT,
  Ledger,
  notionalOf,
  type Market,
} from '../../../sut/backend/ledger.ts'
import { ProductionMatchingEngine } from '../../../sut/backend/engine/matching-engine.ts'
import { ACCOUNTS, commandSequence } from '../../framework/commands.ts'

const RUNS = Number(process.env.PROPERTY_RUNS ?? 300)

const MARKET: Market = {
  symbol: 'ETH-USDC',
  quoteScale: 10_000n,
  baseScale: 1_000_000n,
  makerFeeBps: 2n,
  takerFeeBps: 7n,
}

const FUNDING_BASE = 1_000_000_000n
const FUNDING_QUOTE = 1_000_000_000_000n

describe('ledger conservation', () => {
  it('conserves base and quote across any trading session', () => {
    fc.assert(
      fc.property(commandSequence(60), (commands) => {
        const engine = new ProductionMatchingEngine()
        const ledger = new Ledger(MARKET)
        for (const account of ACCOUNTS) {
          ledger.deposit(account, FUNDING_BASE, FUNDING_QUOTE)
        }

        const baseAtStart = ledger.totalBase()
        const quoteAtStart = ledger.totalQuote()
        let feesAtLastCheck = 0n
        const ids: string[] = []

        for (const command of commands) {
          const trades =
            command.kind === 'submit'
              ? (ids.push(command.request.id), engine.submit(command.request).trades)
              : (engine.cancel(ids[command.targetIndex % Math.max(ids.length, 1)] ?? 'x'), [])

          for (const trade of trades) {
            const notional = notionalOf(MARKET, trade.price, trade.quantity)
            ledger.settle(trade)

            expect(ledger.totalBase()).toBe(baseAtStart)
            expect(ledger.totalQuote()).toBe(quoteAtStart)

            // The fee account only ever grows.
            expect(ledger.feesCollected()).toBeGreaterThanOrEqual(feesAtLastCheck)

            // Exactly the two legs' fees arrived, no more and no less.
            const expected = feeOf(notional, MARKET.makerFeeBps) + feeOf(notional, MARKET.takerFeeBps)
            expect(ledger.feesCollected() - feesAtLastCheck).toBe(expected)
            feesAtLastCheck = ledger.feesCollected()

            for (const account of ledger.accounts()) {
              expect(ledger.baseOf(account)).toBeGreaterThanOrEqual(0n)
              expect(ledger.quoteOf(account)).toBeGreaterThanOrEqual(0n)
            }
          }
        }
      }),
      { numRuns: RUNS },
    )
  })

  it('never leaves the fee account holding base', () => {
    fc.assert(
      fc.property(commandSequence(40), (commands) => {
        const engine = new ProductionMatchingEngine()
        const ledger = new Ledger(MARKET)
        for (const account of ACCOUNTS) ledger.deposit(account, FUNDING_BASE, FUNDING_QUOTE)

        const ids: string[] = []
        for (const command of commands) {
          if (command.kind !== 'submit') continue
          ids.push(command.request.id)
          for (const trade of engine.submit(command.request).trades) ledger.settle(trade)
        }
        // Fees are charged in quote. Base reaching the fee account would mean a
        // settlement leg went to the wrong place.
        expect(ledger.baseOf(FEE_ACCOUNT)).toBe(0n)
      }),
      { numRuns: RUNS },
    )
  })
})

describe('fee rounding', () => {
  it('never charges less than the exact fee, and never more than one unit over', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 18n }),
        fc.bigInt({ min: 0n, max: 500n }),
        (notional, bps) => {
          const charged = feeOf(notional, bps)
          const exactNumerator = notional * bps
          const floor = exactNumerator / 10_000n
          const isExact = exactNumerator % 10_000n === 0n

          // Rounds up: equals the exact value when it divides, otherwise the
          // next unit above. Never below, which would be a leak.
          expect(charged).toBe(isExact ? floor : floor + 1n)
          expect(charged * 10_000n).toBeGreaterThanOrEqual(exactNumerator)
          expect((charged - 1n) * 10_000n).toBeLessThan(exactNumerator)
        },
      ),
      { numRuns: 2000 },
    )
  })

  it('rounds up rather than to nearest, on a case where the two differ', () => {
    // 1 unit of notional at 1 bp is 0.0001 units of fee. To nearest is zero,
    // which would let a client trade for free. Up is one.
    expect(feeOf(1n, 1n)).toBe(1n)
    expect(ceilDiv(1n, 10_000n)).toBe(1n)
  })

  it('charges nothing on a zero-fee market', () => {
    expect(feeOf(1_000_000n, 0n)).toBe(0n)
  })
})
