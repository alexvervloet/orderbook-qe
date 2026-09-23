/**
 * The exchange service: matching, settlement and market data in one place.
 *
 * Holds the single writer to engine and ledger state, and publishes a
 * sequenced market data stream as a side effect of every mutation. The
 * sequence number is the contract with market data consumers: it increases by
 * exactly one per published message, forever, and a consumer that sees a gap
 * knows it has missed something and must take a fresh snapshot.
 */
import { ProductionMatchingEngine } from './engine/matching-engine.ts'
import { Ledger, type Market } from './ledger.ts'
import type {
  AccountId,
  BookLevel,
  BookSnapshot,
  OrderId,
  OrderRequest,
  SubmitResult,
  Ticks,
  Trade,
} from '../../spec/types.ts'
import type { MarketDataMessage } from './wire.ts'

export type Subscriber = (message: MarketDataMessage) => void

const levelKey = (side: 'buy' | 'sell', price: Ticks): string => `${side}:${price}`

export class Exchange {
  readonly market: Market
  readonly #engine = new ProductionMatchingEngine()
  readonly #ledger: Ledger
  readonly #subscribers = new Set<Subscriber>()
  readonly #trades: Trade[] = []
  /** Last published aggregate per level, for computing deltas. */
  #published = new Map<string, BookLevel>()
  #sequence = 0
  #orderCounter = 0

  constructor(market: Market) {
    this.market = market
    this.#ledger = new Ledger(market)
  }

  get ledger(): Ledger {
    return this.#ledger
  }

  get sequence(): number {
    return this.#sequence
  }

  deposit(accountId: AccountId, base: bigint, quote: bigint): void {
    this.#ledger.deposit(accountId, base, quote)
  }

  nextOrderId(): OrderId {
    return `ord-${++this.#orderCounter}`
  }

  submit(request: OrderRequest): SubmitResult {
    const result = this.#engine.submit(request)
    for (const trade of result.trades) {
      this.#ledger.settle(trade)
      this.#trades.push(trade)
    }
    this.#publishBookChanges()
    for (const trade of result.trades) {
      this.#publish({
        type: 'trade',
        sequence: ++this.#sequence,
        price: trade.price.toString(),
        quantity: trade.quantity.toString(),
        takerSide: trade.takerSide,
      })
    }
    return result
  }

  cancel(orderId: OrderId): ReturnType<ProductionMatchingEngine['cancel']> {
    const result = this.#engine.cancel(orderId)
    if (result.cancelled) this.#publishBookChanges()
    return result
  }

  book(): BookSnapshot {
    return this.#engine.snapshot()
  }

  position(accountId: AccountId): bigint {
    return this.#engine.position(accountId)
  }

  recentTrades(limit = 50): readonly Trade[] {
    return this.#trades.slice(-limit)
  }

  lastTradePrice(): Ticks | null {
    return this.#engine.lastTradePrice()
  }

  /** Current book plus the sequence it is valid as of. */
  snapshotMessage(): MarketDataMessage {
    const { bids, asks } = this.book()
    return {
      type: 'snapshot',
      sequence: this.#sequence,
      bids: bids.map(encodeLevel),
      asks: asks.map(encodeLevel),
    }
  }

  subscribe(subscriber: Subscriber): () => void {
    this.#subscribers.add(subscriber)
    return () => this.#subscribers.delete(subscriber)
  }

  #publish(message: MarketDataMessage): void {
    for (const subscriber of this.#subscribers) subscriber(message)
  }

  /**
   * Diff the book against what was last published and emit one delta message
   * covering every changed level, including levels that emptied.
   */
  #publishBookChanges(): void {
    const { bids, asks } = this.book()
    const current = new Map<string, BookLevel>()
    for (const level of bids) current.set(levelKey('buy', level.price), level)
    for (const level of asks) current.set(levelKey('sell', level.price), level)

    const changes: { side: 'buy' | 'sell'; price: string; quantity: string; orderCount: number }[] = []

    for (const [key, level] of current) {
      const before = this.#published.get(key)
      if (before?.quantity === level.quantity && before.orderCount === level.orderCount) continue
      changes.push({
        side: key.startsWith('buy') ? 'buy' : 'sell',
        price: level.price.toString(),
        quantity: level.quantity.toString(),
        orderCount: level.orderCount,
      })
    }
    for (const [key, level] of this.#published) {
      if (current.has(key)) continue
      // The level emptied. Zero quantity is the removal instruction.
      changes.push({
        side: key.startsWith('buy') ? 'buy' : 'sell',
        price: level.price.toString(),
        quantity: '0',
        orderCount: 0,
      })
    }

    this.#published = current
    if (changes.length === 0) return
    this.#publish({ type: 'delta', sequence: ++this.#sequence, changes })
  }
}

function encodeLevel(level: BookLevel): { price: string; quantity: string; orderCount: number } {
  return {
    price: level.price.toString(),
    quantity: level.quantity.toString(),
    orderCount: level.orderCount,
  }
}
