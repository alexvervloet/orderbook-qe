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
import { describe, it } from 'vitest'
import { commandSequence } from '../../framework/commands.ts'
import { assertSessions } from '../../framework/corpus.ts'
import { replayDifferential } from '../../framework/sessions.ts'

/** Deeper on a nightly run. See docs/CI-POLICY.md. */
const RUNS = Number(process.env.PROPERTY_RUNS ?? 300)
const FOUND_BY = 'qe/suites/property/differential.test.ts'

describe('production engine matches the reference engine', () => {
  it('over random trading sessions', () => {
    assertSessions(commandSequence(40), replayDifferential, { runs: RUNS, foundBy: FOUND_BY })
  })

  it('over long sessions that build deep books', () => {
    assertSessions(commandSequence(150), replayDifferential, {
      runs: Math.max(1, Math.floor(RUNS / 5)),
      foundBy: FOUND_BY,
    })
  })
})
