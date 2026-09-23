/**
 * Balance and fee settlement. See spec/LEDGER.md.
 *
 * Every amount is an integer count of an asset's smallest unit. Nothing here
 * divides without deciding the rounding direction first.
 */
import type { AccountId, Lots, Ticks, Trade } from '../../spec/types.ts'

export interface Market {
  readonly symbol: string
  /** Quote units per lot per tick. */
  readonly quoteScale: bigint
  /** Base units per lot. */
  readonly baseScale: bigint
  readonly makerFeeBps: bigint
  readonly takerFeeBps: bigint
}

export interface Balance {
  readonly base: bigint
  readonly quote: bigint
}

export class OverdraftError extends Error {
  readonly accountId: AccountId
  readonly asset: 'base' | 'quote'
  readonly shortfall: bigint

  constructor(accountId: AccountId, asset: 'base' | 'quote', shortfall: bigint) {
    super(`${accountId} is short ${shortfall} ${asset}`)
    this.name = 'OverdraftError'
    this.accountId = accountId
    this.asset = asset
    this.shortfall = shortfall
  }
}

/** Division that rounds away from zero for positive inputs. */
export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator
}

export function notionalOf(market: Market, price: Ticks, quantity: Lots): bigint {
  return quantity * price * market.quoteScale
}

export function feeOf(notional: bigint, bps: bigint): bigint {
  return ceilDiv(notional * bps, 10_000n)
}

export const FEE_ACCOUNT: AccountId = '__fees__'

export class Ledger {
  readonly #market: Market
  readonly #base = new Map<AccountId, bigint>()
  readonly #quote = new Map<AccountId, bigint>()

  constructor(market: Market) {
    this.#market = market
    this.#quote.set(FEE_ACCOUNT, 0n)
    this.#base.set(FEE_ACCOUNT, 0n)
  }

  /** Fund an account. The only way value enters the system. */
  deposit(accountId: AccountId, base: bigint, quote: bigint): void {
    if (base < 0n || quote < 0n) throw new Error('deposit must be non-negative')
    this.#base.set(accountId, this.baseOf(accountId) + base)
    this.#quote.set(accountId, this.quoteOf(accountId) + quote)
  }

  baseOf(accountId: AccountId): bigint {
    return this.#base.get(accountId) ?? 0n
  }

  quoteOf(accountId: AccountId): bigint {
    return this.#quote.get(accountId) ?? 0n
  }

  balanceOf(accountId: AccountId): Balance {
    return { base: this.baseOf(accountId), quote: this.quoteOf(accountId) }
  }

  accounts(): readonly AccountId[] {
    return [...new Set([...this.#base.keys(), ...this.#quote.keys()])]
  }

  totalBase(): bigint {
    return this.accounts().reduce((sum, id) => sum + this.baseOf(id), 0n)
  }

  totalQuote(): bigint {
    return this.accounts().reduce((sum, id) => sum + this.quoteOf(id), 0n)
  }

  feesCollected(): bigint {
    return this.quoteOf(FEE_ACCOUNT)
  }

  /**
   * Settle one trade. Throws `OverdraftError` rather than carrying a negative
   * balance: an overdraw here means the risk layer let something through, and
   * the useful behaviour is to stop and name the account.
   */
  settle(trade: Trade): void {
    const market = this.#market
    const notional = notionalOf(market, trade.price, trade.quantity)
    const baseAmount = trade.quantity * market.baseScale
    const takerFee = feeOf(notional, market.takerFeeBps)
    const makerFee = feeOf(notional, market.makerFeeBps)

    const buyer = trade.takerSide === 'buy' ? trade.takerAccountId : trade.makerAccountId
    const seller = trade.takerSide === 'buy' ? trade.makerAccountId : trade.takerAccountId
    const buyerFee = trade.takerSide === 'buy' ? takerFee : makerFee
    const sellerFee = trade.takerSide === 'buy' ? makerFee : takerFee

    // Check every leg before moving anything, so a rejected trade leaves no
    // partial settlement behind.
    this.#require(seller, 'base', baseAmount)
    this.#require(buyer, 'quote', notional + buyerFee)
    this.#require(seller, 'quote', sellerFee - notional)

    this.#addBase(seller, -baseAmount)
    this.#addBase(buyer, baseAmount)
    this.#addQuote(buyer, -notional - buyerFee)
    this.#addQuote(seller, notional - sellerFee)
    this.#addQuote(FEE_ACCOUNT, buyerFee + sellerFee)
  }

  #require(accountId: AccountId, asset: 'base' | 'quote', amount: bigint): void {
    if (amount <= 0n) return
    const held = asset === 'base' ? this.baseOf(accountId) : this.quoteOf(accountId)
    if (held < amount) throw new OverdraftError(accountId, asset, amount - held)
  }

  #addBase(accountId: AccountId, delta: bigint): void {
    this.#base.set(accountId, this.baseOf(accountId) + delta)
  }

  #addQuote(accountId: AccountId, delta: bigint): void {
    this.#quote.set(accountId, this.quoteOf(accountId) + delta)
  }
}
