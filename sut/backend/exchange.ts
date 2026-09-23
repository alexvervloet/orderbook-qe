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
import { feeOf, Ledger, notionalOf, type Market } from './ledger.ts'
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

/**
 * Raised when matching and settlement disagree about what happened.
 *
 * This should be unreachable. It exists because the alternative to raising is
 * carrying on with an engine that believes a trade occurred and a ledger that
 * does not, and an exchange in that state will keep trading on numbers that are
 * already wrong. Loud and stopped beats quiet and inconsistent.
 */
export class SettlementInconsistencyError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(message, options)
    this.name = 'SettlementInconsistencyError'
  }
}

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
    // Affordability is checked before matching, not after.
    //
    // Matching first and settling second let an unfunded account consume a
    // maker's resting order: the book changed, positions moved, settlement
    // threw, and the ledger never moved. The maker lost their liquidity for a
    // trade that did not happen. See docs/FAILURE-MODES.md.
    const shortfall = this.#worstCaseShortfall(request)
    if (shortfall !== null) {
      return {
        orderId: request.id,
        outcome: { kind: 'rejected', reason: 'insufficient_funds' },
        trades: [],
        cancelled: [],
      }
    }

    const result = this.#engine.submit(request)
    for (const trade of result.trades) {
      try {
        this.#ledger.settle(trade)
      } catch (error) {
        throw new SettlementInconsistencyError(
          `trade ${trade.id} matched but could not settle; engine and ledger now disagree`,
          { cause: error },
        )
      }
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

  /**
   * The worst the incoming order could cost its account, or null if affordable.
   *
   * Deliberately conservative: it prices the whole order at the least
   * favourable price it could possibly trade at, rather than simulating the
   * fills. Simulating would be exact, and would need a second copy of the book
   * to run against, which is a lot of machinery to avoid rejecting a few orders
   * that would in fact have been affordable.
   *
   * Being conservative is the right direction for the error to run in. Refusing
   * an order somebody could afford is an inconvenience they can see and retry.
   * Accepting one they cannot afford corrupts the book.
   */
  #worstCaseShortfall(request: OrderRequest): string | null {
    const worstPrice = this.#worstExecutionPrice(request)
    if (worstPrice === null) return null // nothing to trade against

    const notional = notionalOf(this.market, worstPrice, request.quantity)
    const fee = feeOf(notional, this.market.takerFeeBps)
    const balance = this.#ledger.balanceOf(request.accountId)

    if (request.side === 'buy') {
      return balance.quote >= notional + fee ? null : 'quote'
    }
    // A sell needs the base it is selling, and quote for the fee.
    const baseNeeded = request.quantity * this.market.baseScale
    if (balance.base < baseNeeded) return 'base'
    return balance.quote >= fee ? null : 'quote'
  }

  /**
   * The least favourable price this order could execute at.
   *
   * Stops are checked at submission like everything else. They used to be
   * skipped, "priced when they trigger", except nothing priced them then: an
   * unfunded stop triggered inside somebody else's order and settlement threw
   * after the engine had moved. A stop's funds can still fall after it is
   * accepted, which is the maker-side gap in docs/NON-GOALS.md, but an account
   * that could never pay is refused at the door.
   */
  #worstExecutionPrice(request: OrderRequest): Ticks | null {
    if (request.type === 'limit' || request.type === 'stop_limit') return request.price
    // A market order has no limit, so the worst case is the far side of the
    // book. An empty book means no execution is possible at all.
    const { bids, asks } = this.book()
    const farSide = (request.side === 'buy' ? asks : bids).at(-1)?.price ?? null
    if (request.type === 'market') return farSide
    // A stop_market into an empty book will still trade once it triggers, and
    // the trigger is the only price on offer. Take the worse of the two.
    const trigger = request.triggerPrice!
    if (farSide === null) return trigger
    return request.side === 'buy'
      ? (farSide > trigger ? farSide : trigger)
      : (farSide < trigger ? farSide : trigger)
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
