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
  OverdraftError,
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

  it('moves assets between the right two accounts', () => {
    // Conservation alone cannot see this. Crediting the seller's base to the
    // seller conserves base perfectly while trading with nobody. A mutation
    // that made buyer and seller the same account survived every conservation
    // assertion above. See docs/FAILURE-MODES.md.
    fc.assert(
      fc.property(commandSequence(40), (commands) => {
        const engine = new ProductionMatchingEngine()
        const ledger = new Ledger(MARKET)
        for (const account of ACCOUNTS) ledger.deposit(account, FUNDING_BASE, FUNDING_QUOTE)

        const ids: string[] = []
        for (const command of commands) {
          if (command.kind !== 'submit') continue
          ids.push(command.request.id)

          for (const trade of engine.submit(command.request).trades) {
            const buyer =
              trade.takerSide === 'buy' ? trade.takerAccountId : trade.makerAccountId
            const seller =
              trade.takerSide === 'buy' ? trade.makerAccountId : trade.takerAccountId

            const buyerBefore = ledger.baseOf(buyer)
            const sellerBefore = ledger.baseOf(seller)
            const notional = notionalOf(MARKET, trade.price, trade.quantity)
            const buyerQuoteBefore = ledger.quoteOf(buyer)

            ledger.settle(trade)

            const baseAmount = trade.quantity * MARKET.baseScale
            if (buyer === seller) {
              // A self-trade nets to nothing in base, and still costs both fees.
              expect(ledger.baseOf(buyer)).toBe(buyerBefore)
            } else {
              expect(ledger.baseOf(buyer)).toBe(buyerBefore + baseAmount)
              expect(ledger.baseOf(seller)).toBe(sellerBefore - baseAmount)
              // The buyer pays the notional plus exactly one fee, no more.
              const paid = buyerQuoteBefore - ledger.quoteOf(buyer)
              expect(paid).toBeGreaterThanOrEqual(notional)
              expect(paid - notional).toBeLessThanOrEqual(
                feeOf(notional, MARKET.takerFeeBps),
              )
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

describe('deposit validation', () => {
  it('accepts a zero deposit as a no-op', () => {
    const ledger = new Ledger(MARKET)
    ledger.deposit('alice', 0n, 0n)
    expect(ledger.balanceOf('alice')).toEqual({ base: 0n, quote: 0n })
  })

  it('rejects a negative base deposit', () => {
    const ledger = new Ledger(MARKET)
    expect(() => ledger.deposit('alice', -1n, 0n)).toThrow(/non-negative/)
  })

  it('rejects a negative quote deposit', () => {
    // Checked separately from base. A single test covering both passes even if
    // the validation only looks at one of them.
    const ledger = new Ledger(MARKET)
    expect(() => ledger.deposit('alice', 0n, -1n)).toThrow(/non-negative/)
  })
})

describe('the overdraft guard', () => {
  const trade = (takerSide: 'buy' | 'sell', price: bigint, quantity: bigint) => ({
    id: 't1',
    takerOrderId: 'o1',
    makerOrderId: 'o2',
    takerAccountId: 'taker',
    makerAccountId: 'maker',
    takerSide,
    price,
    quantity,
    sequence: 1,
  })

  it('allows a trade that spends a balance down to exactly zero', () => {
    // The boundary. `held < amount` and `held <= amount` differ on exactly one
    // input, and it is the one where a trader spends their whole balance, which
    // is neither rare nor an error.
    const ledger = new Ledger(MARKET)
    const price = 100n
    const quantity = 2n
    const notional = notionalOf(MARKET, price, quantity)
    const fee = feeOf(notional, MARKET.takerFeeBps)

    ledger.deposit('taker', 0n, notional + fee)
    ledger.deposit('maker', quantity * MARKET.baseScale, feeOf(notional, MARKET.makerFeeBps))

    expect(() => ledger.settle(trade('buy', price, quantity))).not.toThrow()
    expect(ledger.quoteOf('taker')).toBe(0n)
    expect(ledger.baseOf('maker')).toBe(0n)
  })

  it('refuses a buyer one unit short of the notional', () => {
    const ledger = new Ledger(MARKET)
    const notional = notionalOf(MARKET, 100n, 2n)
    const fee = feeOf(notional, MARKET.takerFeeBps)

    ledger.deposit('taker', 0n, notional + fee - 1n)
    ledger.deposit('maker', 2n * MARKET.baseScale, 10n ** 12n)

    expect(() => ledger.settle(trade('buy', 100n, 2n))).toThrow(OverdraftError)
  })

  it('names the asset that is short, not just that something is', () => {
    // The guard chooses which balance to check from the asset argument.
    // Swapping that choice still throws, so a test that only asserts "throws"
    // cannot see the mistake. It has to check which asset it named.
    const ledger = new Ledger(MARKET)
    ledger.deposit('taker', 0n, 10n ** 18n)
    ledger.deposit('maker', 0n, 10n ** 18n) // plenty of quote, no base at all

    try {
      ledger.settle(trade('buy', 100n, 2n))
      expect.unreachable('the seller holds no base')
    } catch (error) {
      expect(error).toBeInstanceOf(OverdraftError)
      expect((error as OverdraftError).asset).toBe('base')
      expect((error as OverdraftError).accountId).toBe('maker')
    }
  })

  it('names quote when the buyer is the one who cannot pay', () => {
    const ledger = new Ledger(MARKET)
    ledger.deposit('taker', 10n ** 18n, 0n) // base but no quote
    ledger.deposit('maker', 10n ** 18n, 10n ** 18n)

    try {
      ledger.settle(trade('buy', 100n, 2n))
      expect.unreachable('the buyer holds no quote')
    } catch (error) {
      expect((error as OverdraftError).asset).toBe('quote')
      expect((error as OverdraftError).accountId).toBe('taker')
    }
  })
})
