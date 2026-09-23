import { describe, it, expect, beforeEach } from 'vitest'
import {
  Ledger,
  ceilDiv,
  notionalOf,
  feeOf,
  FEE_ACCOUNT,
  OverdraftError,
  type Market,
} from '../../../sut/backend/ledger.ts'
import type { Trade } from '../../../spec/types.ts'

function makeMarket(overrides: Partial<Market> = {}): Market {
  return {
    symbol: 'TEST/USD',
    quoteScale: 1n,
    baseScale: 1n,
    makerFeeBps: 10n, // 0.1%
    takerFeeBps: 20n, // 0.2%
    ...overrides,
  }
}

function makeTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    takerAccountId: 'taker',
    makerAccountId: 'maker',
    takerSide: 'buy',
    price: 100n,
    quantity: 10n,
    ...overrides,
  } as Trade
}

describe('ceilDiv', () => {
  it('returns 0 for 0 numerator', () => {
    expect(ceilDiv(0n, 7n)).toBe(0n)
  })

  it('divides evenly with no remainder', () => {
    expect(ceilDiv(10n, 5n)).toBe(2n)
  })

  it('rounds up with a remainder', () => {
    expect(ceilDiv(11n, 5n)).toBe(3n)
  })

  it('rounds up just past a threshold', () => {
    expect(ceilDiv(10001n, 10000n)).toBe(2n)
    expect(ceilDiv(10000n, 10000n)).toBe(1n)
    expect(ceilDiv(9999n, 10000n)).toBe(1n)
  })

  it('handles values beyond 2^53', () => {
    const huge = (1n << 60n) + 1n
    expect(ceilDiv(huge, 2n)).toBe((huge + 1n) / 2n)
    // exact large division
    const exact = (1n << 60n)
    expect(ceilDiv(exact, 4n)).toBe(exact / 4n)
  })
})

describe('notionalOf', () => {
  it('computes quantity * price * quoteScale', () => {
    const market = makeMarket({ quoteScale: 3n })
    expect(notionalOf(market, 100n, 10n)).toBe(10n * 100n * 3n)
  })

  it('is zero when quantity is zero', () => {
    const market = makeMarket()
    expect(notionalOf(market, 100n, 0n)).toBe(0n)
  })

  it('handles large values beyond 2^53', () => {
    const market = makeMarket({ quoteScale: 1n })
    const price = 1n << 30n
    const quantity = 1n << 30n
    expect(notionalOf(market, price, quantity)).toBe(price * quantity)
    expect(notionalOf(market, price, quantity) > 9007199254740993n).toBe(true)
  })
})

describe('feeOf', () => {
  it('is zero for zero notional', () => {
    expect(feeOf(0n, 100n)).toBe(0n)
  })

  it('is zero for zero bps', () => {
    expect(feeOf(1_000_000n, 0n)).toBe(0n)
  })

  it('rounds up when the division is inexact', () => {
    // notional * bps = 3 -> 3/10000 rounds up to 1
    expect(feeOf(3n, 10_000n / 10_000n)).toBe(feeOf(3n, 1n))
    expect(feeOf(1n, 1n)).toBe(1n) // 1*1/10000 -> ceil(1/10000) = 1
  })

  it('matches exact division when evenly divisible', () => {
    // notional=10000, bps=100 -> 10000*100/10000 = 100 exactly
    expect(feeOf(10_000n, 100n)).toBe(100n)
  })

  it('rounds up by exactly one unit past an exact threshold', () => {
    // notional=10001, bps=100 -> 1000100/10000 = 100.01 -> ceil = 101
    expect(feeOf(10_001n, 100n)).toBe(101n)
  })

  it('handles large notional beyond 2^53', () => {
    const notional = (1n << 53n) + 3n
    const bps = 25n // 0.25%
    const exact = notional * bps
    const expected = (exact + 9_999n) / 10_000n
    expect(feeOf(notional, bps)).toBe(expected)
  })
})

describe('Ledger.settle basic direction and fees', () => {
  let ledger: Ledger
  let market: Market

  beforeEach(() => {
    market = makeMarket({ quoteScale: 1n, baseScale: 1n, makerFeeBps: 10n, takerFeeBps: 20n })
    ledger = new Ledger(market)
    ledger.deposit('taker', 0n, 1_000_000n)
    ledger.deposit('maker', 1_000_000n, 1_000_000n)
  })

  it('moves base to buyer and quote to seller when taker buys', () => {
    const trade = makeTrade({ takerSide: 'buy', price: 100n, quantity: 10n })
    const notional = 100n * 10n * market.quoteScale
    ledger.settle(trade)

    expect(ledger.baseOf('taker')).toBe(10n)
    expect(ledger.baseOf('maker')).toBe(1_000_000n - 10n)

    const takerFee = feeOf(notional, market.takerFeeBps)
    const makerFee = feeOf(notional, market.makerFeeBps)

    expect(ledger.quoteOf('taker')).toBe(1_000_000n - notional - takerFee)
    expect(ledger.quoteOf('maker')).toBe(1_000_000n + notional - makerFee)
    expect(ledger.feesCollected()).toBe(takerFee + makerFee)
  })

  it('swaps direction when taker sells', () => {
    ledger.deposit('taker', 1_000_000n, 0n)
    const trade = makeTrade({ takerSide: 'sell', price: 100n, quantity: 10n })
    const notional = 100n * 10n * market.quoteScale

    ledger.settle(trade)

    // taker sold base, gained quote
    expect(ledger.baseOf('taker')).toBe(1_000_000n - 10n)
    // maker bought base
    expect(ledger.baseOf('maker')).toBe(1_000_000n + 10n)

    const takerFee = feeOf(notional, market.takerFeeBps)
    const makerFee = feeOf(notional, market.makerFeeBps)

    expect(ledger.quoteOf('taker')).toBe(1_000_000n + notional - takerFee)
    expect(ledger.quoteOf('maker')).toBe(1_000_000n - notional - makerFee)
    expect(ledger.feesCollected()).toBe(takerFee + makerFee)
  })

  it('handles zero quantity trades without changing balances besides fees', () => {
    const trade = makeTrade({ price: 100n, quantity: 0n })
    const baseBefore = ledger.baseOf('taker')
    const quoteBefore = ledger.quoteOf('taker')
    ledger.settle(trade)
    expect(ledger.baseOf('taker')).toBe(baseBefore)
    expect(ledger.quoteOf('taker')).toBe(quoteBefore)
    expect(ledger.feesCollected()).toBe(0n)
  })
})

describe('Ledger overdraft', () => {
  it('throws OverdraftError when buyer lacks quote funds', () => {
    const market = makeMarket()
    const ledger = new Ledger(market)
    ledger.deposit('maker', 1_000n, 0n)
    ledger.deposit('taker', 0n, 0n) // taker has no quote
    const trade = makeTrade({ takerSide: 'buy', price: 100n, quantity: 10n })
    expect(() => ledger.settle(trade)).toThrow(OverdraftError)
  })

  it('throws OverdraftError when seller lacks base funds', () => {
    const market = makeMarket()
    const ledger = new Ledger(market)
    ledger.deposit('taker', 0n, 1_000_000n)
    ledger.deposit('maker', 0n, 0n) // maker has no base to sell
    const trade = makeTrade({ takerSide: 'buy', price: 100n, quantity: 10n })
    expect(() => ledger.settle(trade)).toThrow(OverdraftError)
  })

  it('does not partially settle on overdraft: balances unchanged after failed settle', () => {
    const market = makeMarket()
    const ledger = new Ledger(market)
    ledger.deposit('taker', 0n, 5n) // not enough quote
    ledger.deposit('maker', 1_000n, 0n)
    const takerBaseBefore = ledger.baseOf('taker')
    const takerQuoteBefore = ledger.quoteOf('taker')
    const makerBaseBefore = ledger.baseOf('maker')
    const makerQuoteBefore = ledger.quoteOf('maker')
    const feesBefore = ledger.feesCollected()

    const trade = makeTrade({ takerSide: 'buy', price: 100n, quantity: 10n })
    expect(() => ledger.settle(trade)).toThrow(OverdraftError)

    expect(ledger.baseOf('taker')).toBe(takerBaseBefore)
    expect(ledger.quoteOf('taker')).toBe(takerQuoteBefore)
    expect(ledger.baseOf('maker')).toBe(makerBaseBefore)
    expect(ledger.quoteOf('maker')).toBe(makerQuoteBefore)
    expect(ledger.feesCollected()).toBe(feesBefore)
  })

  it('never leaves a negative balance after a successful settle', () => {
    const market = makeMarket()
    const ledger = new Ledger(market)
    ledger.deposit('taker', 0n, 1_000_000n)
    ledger.deposit('maker', 1_000n, 0n)
    const trade = makeTrade({ takerSide: 'buy', price: 100n, quantity: 10n })
    ledger.settle(trade)
    for (const id of ledger.accounts()) {
      expect(ledger.baseOf(id)).toBeGreaterThanOrEqual(0n)
      expect(ledger.quoteOf(id)).toBeGreaterThanOrEqual(0n)
    }
  })
})

describe('Ledger invariants over randomized trade sequences', () => {
  // Deterministic PRNG so failures reproduce.
  function mulberry32(seed: number) {
    let a = seed
    return () => {
      a |= 0
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  function pick<T>(arr: readonly T[], idx: number): T {
    const v = arr[idx]
    if (v === undefined) throw new Error('index out of range')
    return v
  }

  it('preserves base conservation, quote conservation, fee monotonicity, and non-negativity', () => {
    const rand = mulberry32(12345)
    const market = makeMarket({
      quoteScale: 2n,
      baseScale: 3n,
      makerFeeBps: 15n,
      takerFeeBps: 30n,
    })
    const ledger = new Ledger(market)
    const accounts: readonly string[] = ['a', 'b', 'c', 'd']
    for (const acc of accounts) {
      ledger.deposit(acc, 10_000_000n, 10_000_000n)
    }

    const totalBaseBefore = ledger.totalBase()
    const totalQuoteBefore = ledger.totalQuote()
    let prevFees = ledger.feesCollected()

    for (let i = 0; i < 500; i++) {
      const takerIdx = Math.floor(rand() * accounts.length)
      let makerIdx = Math.floor(rand() * accounts.length)
      while (makerIdx === takerIdx) makerIdx = Math.floor(rand() * accounts.length)

      const takerAccountId = pick(accounts, takerIdx)
      const makerAccountId = pick(accounts, makerIdx)
      const takerSide: 'buy' | 'sell' = rand() < 0.5 ? 'buy' : 'sell'
      const price = BigInt(1 + Math.floor(rand() * 200))
      const quantity = BigInt(1 + Math.floor(rand() * 50))

      const trade = makeTrade({ takerAccountId, makerAccountId, takerSide, price, quantity })

      try {
        ledger.settle(trade)
      } catch (err) {
        expect(err).toBeInstanceOf(OverdraftError)
        continue
      }

      // Base conservation
      expect(ledger.totalBase()).toBe(totalBaseBefore)
      // Quote conservation (including fee account)
      expect(ledger.totalQuote()).toBe(totalQuoteBefore)
      // Fee monotonicity
      const newFees = ledger.feesCollected()
      expect(newFees).toBeGreaterThanOrEqual(prevFees)
      prevFees = newFees
      // Non-negativity
      for (const acc of ledger.accounts()) {
        expect(ledger.baseOf(acc)).toBeGreaterThanOrEqual(0n)
        expect(ledger.quoteOf(acc)).toBeGreaterThanOrEqual(0n)
      }
    }
  })

  it('bounds each trade fee between the exact fee and exact fee plus one', () => {
    const rand = mulberry32(999)
    const market = makeMarket({
      quoteScale: 5n,
      baseScale: 1n,
      makerFeeBps: 7n,
      takerFeeBps: 13n,
    })
    const ledger = new Ledger(market)
    const accounts = ['x', 'y']
    for (const acc of accounts) ledger.deposit(acc, 1_000_000_000n, 1_000_000_000n)

    for (let i = 0; i < 200; i++) {
      const takerSide: 'buy' | 'sell' = rand() < 0.5 ? 'buy' : 'sell'
      const price = BigInt(1 + Math.floor(rand() * 500))
      const quantity = BigInt(1 + Math.floor(rand() * 100))
      const trade = makeTrade({
        takerAccountId: 'x',
        makerAccountId: 'y',
        takerSide,
        price,
        quantity,
      })

      const notional = notionalOf(market, price, quantity)
      const exactTaker = (notional * market.takerFeeBps) / 10_000n
      const exactMaker = (notional * market.makerFeeBps) / 10_000n
      const takerFee = feeOf(notional, market.takerFeeBps)
      const makerFee = feeOf(notional, market.makerFeeBps)

      expect(takerFee).toBeGreaterThanOrEqual(exactTaker)
      expect(takerFee).toBeLessThanOrEqual(exactTaker + 1n)
      expect(makerFee).toBeGreaterThanOrEqual(exactMaker)
      expect(makerFee).toBeLessThanOrEqual(exactMaker + 1n)

      ledger.settle(trade)
    }
  })

  it('fee is always at least the exact proportional fee and at most one unit more, with large values beyond 2^53', () => {
    const market = makeMarket({ quoteScale: 1n, baseScale: 1n, makerFeeBps: 3n, takerFeeBps: 3n })
    const notional = (1n << 55n) + 7n
    const exact = (notional * market.takerFeeBps) / 10_000n
    const fee = feeOf(notional, market.takerFeeBps)
    expect(fee).toBeGreaterThanOrEqual(exact)
    expect(fee).toBeLessThanOrEqual(exact + 1n)
  })
})

describe('FEE_ACCOUNT', () => {
  it('starts at zero base and quote', () => {
    const market = makeMarket()
    const ledger = new Ledger(market)
    expect(ledger.baseOf(FEE_ACCOUNT)).toBe(0n)
    expect(ledger.quoteOf(FEE_ACCOUNT)).toBe(0n)
  })

  it('only ever accumulates quote fees, never loses them', () => {
    const market = makeMarket({ makerFeeBps: 25n, takerFeeBps: 25n })
    const ledger = new Ledger(market)
    ledger.deposit('taker', 0n, 1_000_000n)
    ledger.deposit('maker', 1_000_000n, 0n)
    ledger.settle(makeTrade({ takerSide: 'buy', price: 50n, quantity: 5n }))
    expect(ledger.feesCollected()).toBeGreaterThan(0n)
  })
})
