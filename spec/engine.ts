/**
 * The interface both matching engines implement.
 *
 * The differential test in `qe/suites/property` drives an identical command
 * sequence through two objects typed as `MatchingEngine` and compares
 * everything observable. Anything an implementation exposes beyond this
 * interface is invisible to that test, which is the point: the comparison is
 * over behaviour, not over internals.
 */
import type {
  AccountId,
  BookSnapshot,
  CancelResult,
  Lots,
  OrderId,
  OrderRequest,
  RestingOrder,
  SubmitResult,
  Ticks,
} from './types.ts'

export interface MatchingEngine {
  /** Apply an order. Never throws for a bad order; returns a rejection. */
  submit(request: OrderRequest): SubmitResult

  /** Idempotent. Returns `cancelled: false` if the order was already gone. */
  cancel(orderId: OrderId): CancelResult

  /** Aggregated visible depth. Hidden iceberg quantity is excluded. */
  snapshot(): BookSnapshot

  /**
   * Every live resting order, in priority order: best price first, then lowest
   * sequence. Untriggered stops are excluded because they are not in the book.
   * Compared field by field in the differential test, which catches queue
   * ordering bugs that an aggregated snapshot would hide.
   */
  restingOrders(): readonly RestingOrder[]

  /** Untriggered stop orders, ascending by sequence. */
  pendingStops(): readonly RestingOrder[]

  /** Price of the most recent trade, or null if nothing has traded. */
  lastTradePrice(): Ticks | null

  /** Signed position in lots. Positive is long, negative is short. */
  position(accountId: AccountId): Lots
}
