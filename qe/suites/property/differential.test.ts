/**
 * Differential test: the production engine against the reference engine.
 *
 * A random trading session is driven through both engines command by command.
 * After every single command the full observable state is compared, so a
 * failure reports the first command where they diverged rather than a mismatch
 * discovered a hundred orders later.
 *
 * Neither engine is assumed correct. A divergence means one of them disagrees
 * with spec/SEMANTICS.md, and which one is a question for the person reading
 * the counterexample.
 */
import fc from 'fast-check'
import { describe, it } from 'vitest'
import { ProductionMatchingEngine } from '../../../sut/backend/engine/matching-engine.ts'
import { ReferenceEngine } from '../../model/reference-engine.ts'
import { ACCOUNTS, commandSequence, describeCommands, type Command } from '../../framework/commands.ts'
import { firstDifference, observeResult, observeState } from '../../framework/differential.ts'

/** Deeper on a nightly run. See docs/CI-POLICY.md. */
const RUNS = Number(process.env.PROPERTY_RUNS ?? 300)

function replay(commands: readonly Command[]): string | null {
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
      const target = submitted[command.targetIndex % Math.max(submitted.length, 1)] ?? 'none'
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
      return [
        `Diverged at command ${index}.`,
        '',
        difference,
        '',
        'Session:',
        describeCommands(commands.slice(0, index + 1)),
      ].join('\n')
    }
  }
  return null
}

describe('production engine matches the reference engine', () => {
  it('over random trading sessions', () => {
    fc.assert(
      fc.property(commandSequence(40), (commands) => {
        const failure = replay(commands)
        if (failure !== null) throw new Error(failure)
      }),
      { numRuns: RUNS, verbose: false },
    )
  })

  it('over long sessions that build deep books', () => {
    fc.assert(
      fc.property(commandSequence(150), (commands) => {
        const failure = replay(commands)
        if (failure !== null) throw new Error(failure)
      }),
      { numRuns: Math.max(1, Math.floor(RUNS / 5)) },
    )
  })
})

export { replay }
