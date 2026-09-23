/**
 * Invariants each engine must hold on its own, with no oracle involved.
 *
 * The differential test compares the production engine with the reference
 * engine, so it cannot see a bug they share. Both were written by the same
 * person from the same spec, and they did share one: a triggered stop could
 * rest before the taker that triggered it, and the taker then rested straight
 * through it, leaving a crossed book. Every differential run passed. See
 * docs/FAILURE-MODES.md.
 *
 * These properties come from spec/SEMANTICS.md directly and hold for any
 * correct engine, whatever the other engine does.
 */
import fc from 'fast-check'
import { describe, it } from 'vitest'
import type { MatchingEngine } from '../../../spec/engine.ts'
import { ProductionMatchingEngine } from '../../../sut/backend/engine/matching-engine.ts'
import { ReferenceEngine } from '../../model/reference-engine.ts'
import { commandSequence, describeCommands, type Command } from '../../framework/commands.ts'

const RUNS = Number(process.env.PROPERTY_RUNS ?? 300)

/** The first broken invariant after the command just applied, or null. */
function brokenInvariant(engine: MatchingEngine): string | null {
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

function replay(create: () => MatchingEngine, commands: readonly Command[]): string | null {
  const engine = create()
  const submitted: string[] = []
  for (const [index, command] of commands.entries()) {
    if (command.kind === 'submit') {
      submitted.push(command.request.id)
      engine.submit(command.request)
    } else {
      engine.cancel(submitted[command.targetIndex % Math.max(submitted.length, 1)] ?? 'none')
    }
    const broken = brokenInvariant(engine)
    if (broken !== null) {
      return [
        `Invariant broken at command ${index}: ${broken}`,
        '',
        'Session:',
        describeCommands(commands.slice(0, index + 1)),
      ].join('\n')
    }
  }
  return null
}

for (const [name, create] of [
  ['reference engine', () => new ReferenceEngine()],
  ['production engine', () => new ProductionMatchingEngine()],
] as const) {
  describe(`${name} holds the book invariants on its own`, () => {
    it('over random trading sessions', () => {
      fc.assert(
        fc.property(commandSequence(60), (commands) => {
          const failure = replay(create, commands)
          if (failure !== null) throw new Error(failure)
        }),
        { numRuns: RUNS },
      )
    })
  })
}
