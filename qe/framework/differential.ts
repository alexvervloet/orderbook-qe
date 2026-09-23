/**
 * Differential comparison between two matching engines.
 *
 * What gets compared is what a client could observe: outcomes, the trade tape,
 * visible depth, queue order, pending stops, last trade price and positions.
 *
 * What does not get compared is anything an implementation is free to choose:
 * trade ids, and the absolute value of sequence numbers. Sequence numbers still
 * matter, but only as an ordering, and the array order already carries that. An
 * engine that allocated its counters differently would otherwise fail this
 * comparison while being perfectly correct, and a suite that cries wolf gets
 * switched off.
 */
import type { MatchingEngine } from '../../spec/engine.ts'
import type { AccountId, SubmitResult } from '../../spec/types.ts'

export interface ObservableState {
  readonly bids: string[]
  readonly asks: string[]
  readonly resting: string[]
  readonly stops: string[]
  readonly lastTradePrice: string
  readonly positions: Record<string, string>
}

export interface ObservableResult {
  readonly outcome: string
  readonly trades: string[]
  readonly cancelled: string[]
}

export function observeResult(result: SubmitResult): ObservableResult {
  const o = result.outcome
  const outcome =
    o.kind === 'rejected'
      ? `rejected:${o.reason}`
      : o.kind === 'partially_filled_and_cancelled'
        ? `cancelled:unfilled=${o.unfilled}`
        : o.kind === 'resting'
          ? `resting:remaining=${o.remaining}`
          : o.kind

  return {
    outcome,
    trades: result.trades.map(
      (t) => `${t.takerSide} ${t.takerOrderId}->${t.makerOrderId} ${t.quantity}@${t.price}`,
    ),
    cancelled: [...result.cancelled],
  }
}

export function observeState(
  engine: MatchingEngine,
  accounts: readonly AccountId[],
): ObservableState {
  const { bids, asks } = engine.snapshot()
  const positions: Record<string, string> = {}
  for (const account of accounts) positions[account] = String(engine.position(account))

  return {
    bids: bids.map((l) => `${l.price}x${l.quantity}/${l.orderCount}`),
    asks: asks.map((l) => `${l.price}x${l.quantity}/${l.orderCount}`),
    resting: engine
      .restingOrders()
      .map((o) => `${o.request.id} rem=${o.remaining} disp=${o.displayed}`),
    stops: engine.pendingStops().map((o) => `${o.request.id} rem=${o.remaining}`),
    lastTradePrice: String(engine.lastTradePrice()),
    positions,
  }
}

/** Returns a human-readable description of the first difference, or null. */
export function firstDifference(
  label: string,
  left: ObservableState | ObservableResult,
  right: ObservableState | ObservableResult,
): string | null {
  const a = JSON.stringify(left, null, 2)
  const b = JSON.stringify(right, null, 2)
  if (a === b) return null

  const aLines = a.split('\n')
  const bLines = b.split('\n')
  const at = aLines.findIndex((line, i) => line !== bLines[i])
  return [
    `${label} diverged`,
    `  reference: ${aLines[at] ?? '<end>'}`,
    `  production: ${bLines[at] ?? '<end>'}`,
  ].join('\n')
}
