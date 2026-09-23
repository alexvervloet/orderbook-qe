import { describe, it, expect } from 'vitest'
import {
  Ledger,
  FEE_ACCOUNT,
  ceilDiv,
  notionalOf,
  feeOf,
  OverdraftError,
  type Market,
} from '../../../sut/backend/ledger.ts'
import type { Trade, AccountId } from '../../../spec/types.ts'

function makeTrade(opts: {
  quantity: bigint
  price: bigint
  takerSide: 'buy' | 'sell'
  takerAccountId: AccountId
  makerAccountId: AccountId
}): Trade {
  return {
    quantity: opts.quantity,
    price: opts.price,
    takerSide: opts.takerSide,
    takerAccountId: opts.takerAccountId,
    makerAccountId: opts.makerAccountId,
  } as Trade
}

const BASIC_MARKET: Market = {
  symbol: 'X/Y',
  quoteScale: 1n,
  baseScale: 1n,
  makerFeeBps: 10n, // 0.1%
  takerFeeBps: 20n, // 0.2%
}

describe('ceilDiv', () => {
  it('zero numerator yields zero', () => {
    expect(ceilDiv(0n, 5n)).toBe(0n)
  })

  it('exact division has no remainder rounding', () => {
    expect(ceilDiv(10n, 5n)).toBe(2n)
    expect(ceilDiv(5n, 5n)).toBe(1n)
  })

  it('one past exact rounds up', () => {
    expect(ceilDiv(6n, 5n)).toBe(2n)
    expect(ceilDiv(11n, 5n)).toBe(3n)
  })

  it('denominator of one is identity', () => {
    expect(ceilDiv(1n, 1n)).toBe(1n)
    expect(ceilDiv(123456789123456789n, 1n)).toBe(123456789123456789n)
  })

  it('handles values above 2^53 precisely', () => {
    const big = (1n << 60n) + 3n // well above Number.MAX_SAFE_INTEGER
    expect(ceilDiv(big, 2n)).toBe((big + 1n) / 2n)
  })
})

describe('notionalOf', () => {
  it('is quantity * price * quoteScale, exactly', () => {
    const market: Market = { ...BASIC_MARKET, quoteScale: 7n }
    expect(notionalOf(market, 3n, 5n)).toBe(3n * 5n * 7n)
  })

  it('zero quantity gives zero notional', () => {
    expect(notionalOf(BASIC_MARKET, 100n, 0n)).toBe(0n)
  })

  it('handles quantities above 2^53', () => {
    const bigQty = (1n << 53n) + 10n
    const market: Market = { ...BASIC_MARKET, quoteScale: 1n }
    expect(notionalOf(market, 2n, bigQty)).toBe(bigQty * 2n)
  })
})

describe('feeOf', () => {
  it('zero notional yields zero fee', () => {
    expect(feeOf(0n, 100n)).toBe(0n)
  })

  it('rounds up at the exact threshold and one past it', () => {
    // notional * bps / 10000 must round up whenever there's a remainder.
    // 10000 * 1 / 10000 = 1 exactly -> no rounding needed
    expect(feeOf(10000n, 1n)).toBe(1n)
    // 10001 * 1 / 10000 = 1.0001 -> rounds up to 2
    expect(feeOf(10001n, 1n)).toBe(2n)
  })

  it('fee is never less than exact proportional fee, never more than exact + 1', () => {
    const cases: Array<[bigint, bigint]> = [
      [1n, 1n],
      [3n, 7n],
      [999n, 33n],
      [1_000_000n, 25n],
      [(1n << 60n) + 123n, 17n],
    ]

    for (const [notional, bps] of cases) {
      const fee = feeOf(notional, bps)
      const exactNumerator = notional * bps
      // fee * 10000 >= exactNumerator  (fee is at least the exact value)
      expect(fee * 10_000n >= exactNumerator).toBe(true)
      // (fee - 1) * 10000 < exactNumerator, i.e. fee is not more than exact + 1 unit
      expect((fee - 1n) * 10_000n < exactNumerator).toBe(true)
    }
  })

  it('handles bps of zero as zero fee', () => {
    expect(feeOf(123456n, 0n)).toBe(0n)
  })
})

describe('Ledger basics', () => {
  it('starts every account at zero', () => {
    const ledger = new Ledger(BASIC_MARKET)
    expect(ledger.baseOf('alice')).toBe(0n)
    expect(ledger.quoteOf('alice')).toBe(0n)
    expect(ledger.feesCollected()).toBe(0n)
  })

  it('deposit increases balances', () => {
    const ledger = new Ledger(BASIC_MARKET)
    ledger.deposit('alice', 10n, 20n)
    expect(ledger.balanceOf('alice')).toEqual({ base: 10n, quote: 20n })
  })

  it('rejects negative deposits', () => {
    const ledger = new Ledger(BASIC_MARKET)
    expect(() => ledger.deposit('alice', -1n, 0n)).toThrow()
    expect(() => ledger.deposit('alice', 0n, -1n)).toThrow()
  })

  it('deposit handles values above 2^53', () => {
    const ledger = new Ledger(BASIC_MARKET)
    const big = (1n << 60n) + 7n
    ledger.deposit('alice', big, big)
    expect(ledger.baseOf('alice')).toBe(big)
    expect(ledger.quoteOf('alice')).toBe(big)
  })
})

describe('settle: taker buy', () => {
  it('moves base and quote in the correct directions and charges fees', () => {
    const market: Market = { symbol: 'X/Y', quoteScale: 1n, baseScale: 1n, makerFeeBps: 10n, takerFeeBps: 20n }
    const ledger = new Ledger(market)
    // taker buys, needs quote; maker sells, needs base.
    ledger.deposit('taker', 0n, 1_000_000n)
    ledger.deposit('maker', 1_000_000n, 0n)

    const trade = makeTrade({
      quantity: 100n,
      price: 50n,
      takerSide: 'buy',
      takerAccountId: 'taker',
      makerAccountId: 'maker',
    })

    const notional = 100n * 50n * market.quoteScale
    const baseAmount = 100n * market.baseScale
    const takerFee = feeOf(notional, market.takerFeeBps)
    const makerFee = feeOf(notional, market.makerFeeBps)

    ledger.settle(trade)

    expect(ledger.baseOf('taker')).toBe(baseAmount)
    expect(ledger.baseOf('maker')).toBe(1_000_000n - baseAmount)
    expect(ledger.quoteOf('taker')).toBe(1_000_000n - notional - takerFee)
    expect(ledger.quoteOf('maker')).toBe(notional - makerFee)
    expect(ledger.feesCollected()).toBe(takerFee + makerFee)
  })
})

describe('settle: taker sell', () => {
  it('swaps the directions relative to a buy', () => {
    const market: Market = { symbol: 'X/Y', quoteScale: 1n, baseScale: 1n, makerFeeBps: 10n, takerFeeBps: 20n }
    const ledger = new Ledger(market)
    // taker sells, needs base; maker buys, needs quote.
    ledger.deposit('taker', 1_000_000n, 0n)
    ledger.deposit('maker', 0n, 1_000_000n)

    const trade = makeTrade({
      quantity: 100n,
      price: 50n,
      takerSide: 'sell',
      takerAccountId: 'taker',
      makerAccountId: 'maker',
    })

    const notional = 100n * 50n * market.quoteScale
    const baseAmount = 100n * market.baseScale
    const takerFee = feeOf(notional, market.takerFeeBps)
    const makerFee = feeOf(notional, market.makerFeeBps)

    ledger.settle(trade)

    expect(ledger.baseOf('taker')).toBe(1_000_000n - baseAmount)
    expect(ledger.baseOf('maker')).toBe(baseAmount)
    expect(ledger.quoteOf('maker')).toBe(1_000_000n - notional - makerFee)
    expect(ledger.quoteOf('taker')).toBe(notional - takerFee)
    expect(ledger.feesCollected()).toBe(takerFee + makerFee)
  })
})

describe('settle: overdraft', () => {
  it('rejects a trade that would overdraw the seller base balance', () => {
    const ledger = new Ledger(BASIC_MARKET)
    ledger.deposit('taker', 0n, 1_000_000n)
    ledger.deposit('maker', 5n, 0n) // not enough base

    const trade = makeTrade({
      quantity: 100n,
      price: 50n,
      takerSide: 'buy',
      takerAccountId: 'taker',
      makerAccountId: 'maker',
    })

    expect(() => ledger.settle(trade)).toThrow(OverdraftError)
  })

  it('rejects a trade that would overdraw the buyer quote balance', () => {
    const ledger = new Ledger(BASIC_MARKET)
    ledger.deposit('taker', 0n, 10n) // not enough quote
    ledger.deposit('maker', 1_000_000n, 0n)

    const trade = makeTrade({
      quantity: 100n,
      price: 50n,
      takerSide: 'buy',
      takerAccountId: 'taker',
      makerAccountId: 'maker',
    })

    expect(() => ledger.settle(trade)).toThrow(OverdraftError)
  })

  it('leaves no partial settlement behind on rejection', () => {
    const ledger = new Ledger(BASIC_MARKET)
    ledger.deposit('taker', 0n, 1_000_000n)
    ledger.deposit('maker', 5n, 0n)

    const before = {
      taker: ledger.balanceOf('taker'),
      maker: ledger.balanceOf('maker'),
      fees: ledger.feesCollected(),
    }

    const trade = makeTrade({
      quantity: 100n,
      price: 50n,
      takerSide: 'buy',
      takerAccountId: 'taker',
      makerAccountId: 'maker',
    })

    expect(() => ledger.settle(trade)).toThrow()

    expect(ledger.balanceOf('taker')).toEqual(before.taker)
    expect(ledger.balanceOf('maker')).toEqual(before.maker)
    expect(ledger.feesCollected()).toBe(before.fees)
  })

  it('never leaves a negative balance after a rejected trade', () => {
    const ledger = new Ledger(BASIC_MARKET)
    ledger.deposit('maker', 1n, 0n)
    const trade = makeTrade({
      quantity: 1000n,
      price: 1000n,
      takerSide: 'buy',
      takerAccountId: 'taker',
      makerAccountId: 'maker',
    })
    expect(() => ledger.settle(trade)).toThrow(OverdraftError)
    for (const id of ledger.accounts()) {
      expect(ledger.baseOf(id)).toBeGreaterThanOrEqual(0n)
      expect(ledger.quoteOf(id)).toBeGreaterThanOrEqual(0n)
    }
  })
})

describe('property: invariants over random trade sequences', () => {
  function makeRng(seed: number) {
    let state = seed >>> 0
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0
      return state / 0xffffffff
    }
  }

  it('base and quote totals are conserved, fees are monotonic and bounded, no negative balances', () => {
    const market: Market = { symbol: 'X/Y', quoteScale: 3n, baseScale: 2n, makerFeeBps: 15n, takerFeeBps: 30n }
    const ledger = new Ledger(market)
    const accounts: readonly AccountId[] = ['a', 'b', 'c', 'd']
    for (const acc of accounts) {
      ledger.deposit(acc, 1_000_000_000n, 1_000_000_000n)
    }

    const totalBaseBefore = ledger.totalBase()
    const totalQuoteBefore = ledger.totalQuote()

    const rng = makeRng(42)
    let lastFees = ledger.feesCollected()

    for (let i = 0; i < 500; i++) {
      const takerIdx = Math.floor(rng() * accounts.length)
      let makerIdx = Math.floor(rng() * accounts.length)
      if (makerIdx === takerIdx) makerIdx = (makerIdx + 1) % accounts.length

      const takerAccountId = accounts[takerIdx] as AccountId
      const makerAccountId = accounts[makerIdx] as AccountId

      const quantity = BigInt(1 + Math.floor(rng() * 20))
      const price = BigInt(1 + Math.floor(rng() * 50))
      const takerSide = rng() < 0.5 ? 'buy' : 'sell'

      const trade = makeTrade({
        quantity,
        price,
        takerSide,
        takerAccountId,
        makerAccountId,
      })

      const notional = notionalOf(market, price, quantity)
      const takerFee = feeOf(notional, market.takerFeeBps)
      const makerFee = feeOf(notional, market.makerFeeBps)

      try {
        ledger.settle(trade)
      } catch (err) {
        expect(err).toBeInstanceOf(OverdraftError)
        continue
      }

      // fee correctness bound
      expect(takerFee * 10_000n >= notional * market.takerFeeBps).toBe(true)
      expect((takerFee - 1n) * 10_000n < notional * market.takerFeeBps).toBe(true)
      expect(makerFee * 10_000n >= notional * market.makerFeeBps).toBe(true)
      expect((makerFee - 1n) * 10_000n < notional * market.makerFeeBps).toBe(true)

      // fee monotonicity
      const nowFees = ledger.feesCollected()
      expect(nowFees >= lastFees).toBe(true)
      lastFees = nowFees

      // conservation
      expect(ledger.totalBase()).toBe(totalBaseBefore)
      expect(ledger.totalQuote()).toBe(totalQuoteBefore)

      // non-negativity
      for (const acc of ledger.accounts()) {
        expect(ledger.baseOf(acc)).toBeGreaterThanOrEqual(0n)
        expect(ledger.quoteOf(acc)).toBeGreaterThanOrEqual(0n)
      }
    }
  })

  it('handles trade quantities and prices above 2^53 without losing precision', () => {
    const market: Market = { symbol: 'X/Y', quoteScale: 1n, baseScale: 1n, makerFeeBps: 5n, takerFeeBps: 10n }
    const ledger = new Ledger(market)
    const bigAmount = (1n << 60n) + 999n
    ledger.deposit('taker', 0n, bigAmount)
    ledger.deposit('maker', bigAmount, 0n)

    const quantity = (1n << 40n) + 3n
    const price = 3n

    const trade = makeTrade({
      quantity,
      price,
      takerSide: 'buy',
      takerAccountId: 'taker',
      makerAccountId: 'maker',
    })

    const notional = notionalOf(market, price, quantity)
    const baseAmount = quantity * market.baseScale
    const takerFee = feeOf(notional, market.takerFeeBps)
    const makerFee = feeOf(notional, market.makerFeeBps)

    ledger.settle(trade)

    expect(ledger.baseOf('taker')).toBe(baseAmount)
    expect(ledger.baseOf('maker')).toBe(bigAmount - baseAmount)
    expect(ledger.quoteOf('taker')).toBe(bigAmount - notional - takerFee)
    expect(ledger.quoteOf('maker')).toBe(notional - makerFee)
    expect(ledger.feesCollected()).toBe(takerFee + makerFee)
  })
})
