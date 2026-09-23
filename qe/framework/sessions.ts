/**
 * Replaying a trading session and reporting the first thing that went wrong.
 *
 * Shared by the property suites, which generate sessions, and the corpus
 * replay, which reads them from disk. A saved counterexample has to be checked
 * by exactly the code that found it, or the corpus stops meaning anything.
 */
import type { MatchingEngine } from '../../spec/engine.ts'
import { ProductionMatchingEngine } from '../../sut/backend/engine/matching-engine.ts'
import { ReferenceEngine } from '../model/reference-engine.ts'
import { ACCOUNTS, describeCommands, type Command } from './commands.ts'
import { firstDifference, observeResult, observeState } from './differential.ts'

function targetOf(command: Command & { kind: 'cancel' }, submitted: readonly string[]): string {
  return submitted[command.targetIndex % Math.max(submitted.length, 1)] ?? 'none'
}

/** Where a replay first went wrong, and a report a person can act on. */
export interface SessionFailure {
  /** Index of the command after which the failure was seen. */
  readonly index: number
  readonly message: string
}

function report(headline: string, commands: readonly Command[], index: number): SessionFailure {
  const session = describeCommands(commands.slice(0, index + 1))
  return { index, message: [headline, '', 'Session:', session].join('\n') }
}

/**
 * Drive both engines through the session and compare every observable after
 * every command. Returns the first divergence, or null.
 */
export function replayDifferential(commands: readonly Command[]): SessionFailure | null {
  const reference = new ReferenceEngine()
  const production = new ProductionMatchingEngine()
  const submitted: string[] = []

  for (const [index, command] of commands.entries()) {
    let difference: string | null = null

    if (command.kind === 'submit') {
      submitted.push(command.request.id)
      const a = reference.submit(command.request)
      const b = production.submit(command.request)
      difference = firstDifference('result', observeResult(a), observeResult(b))
    } else {
      const target = targetOf(command, submitted)
      const a = reference.cancel(target)
      const b = production.cancel(target)
      if (a.cancelled !== b.cancelled || a.remainingAtCancel !== b.remainingAtCancel) {
        difference = `cancel(${target}) diverged\n  reference: ${JSON.stringify(a)}\n  production: ${JSON.stringify(b)}`
      }
    }

    difference ??= firstDifference(
      'state',
      observeState(reference, ACCOUNTS),
      observeState(production, ACCOUNTS),
    )
    if (difference !== null) {
      return report(`Diverged at command ${index}.\n\n${difference}`, commands, index)
    }
  }
  return null
}

/** The first spec invariant the engine breaks in its current state, or null. */
export function brokenInvariant(engine: MatchingEngine): string | null {
  // Section 3: at rest, the best bid is strictly below the best ask.
  const { bids, asks } = engine.snapshot()
  const bestBid = bids[0]?.price
  const bestAsk = asks[0]?.price
  if (bestBid !== undefined && bestAsk !== undefined && bestBid >= bestAsk) {
    return `book is crossed: best bid ${bestBid} >= best ask ${bestAsk}`
  }

  // Section 9: cascades are resolved to completion before the engine returns,
  // so no waiting stop can be triggerable by the current last trade price.
  const last = engine.lastTradePrice()
  if (last !== null) {
    for (const stop of engine.pendingStops()) {
      const trigger = stop.request.triggerPrice!
      const due = stop.request.side === 'buy' ? last >= trigger : last <= trigger
      if (due) {
        return `stop ${stop.request.id} (trigger ${trigger}) still waiting at last trade ${last}`
      }
    }
  }
  return null
}

/**
 * Every resting order's quantity is accounted for: what has filled, plus what
 * is still resting, is what the order was accepted for. Checked from the trade
 * tape, so an engine that loses or invents quantity in a partial fill, an
 * iceberg refresh or a cascade cannot hide it in its own bookkeeping.
 */
function unaccountedQuantity(
  engine: MatchingEngine,
  filled: ReadonlyMap<string, bigint>,
): string | null {
  for (const order of engine.restingOrders()) {
    const traded = filled.get(order.request.id) ?? 0n
    if (traded + order.remaining !== order.request.quantity) {
      return (
        `order ${order.request.id} is not accounted for: ${traded} filled + ` +
        `${order.remaining} resting != ${order.request.quantity} accepted`
      )
    }
  }
  return null
}

/**
 * Drive one engine through the session, checking the invariants after every
 * command. No oracle, so it catches bugs both engines share.
 */
export function replayInvariants(
  create: () => MatchingEngine,
  commands: readonly Command[],
): SessionFailure | null {
  const engine = create()
  const submitted: string[] = []
  const filled = new Map<string, bigint>()
  const fill = (id: string, quantity: bigint): void => {
    filled.set(id, (filled.get(id) ?? 0n) + quantity)
  }
  for (const [index, command] of commands.entries()) {
    if (command.kind === 'submit') {
      submitted.push(command.request.id)
      for (const trade of engine.submit(command.request).trades) {
        fill(trade.takerOrderId, trade.quantity)
        fill(trade.makerOrderId, trade.quantity)
      }
    } else {
      engine.cancel(targetOf(command, submitted))
    }
    const broken = brokenInvariant(engine) ?? unaccountedQuantity(engine, filled)
    if (broken !== null) {
      return report(`Invariant broken at command ${index}: ${broken}`, commands, index)
    }
  }
  return null
}

export const ENGINES = [
  ['reference engine', () => new ReferenceEngine()],
  ['production engine', () => new ProductionMatchingEngine()],
] as const
