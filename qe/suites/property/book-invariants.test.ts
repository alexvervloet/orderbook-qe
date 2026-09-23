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
 * The invariants come from spec/SEMANTICS.md directly and hold for any correct
 * engine, whatever the other engine does. They live in qe/framework/sessions.ts
 * so the corpus replays saved sessions against exactly the same checks.
 */
import { describe, it } from 'vitest'
import { commandSequence } from '../../framework/commands.ts'
import { assertSessions } from '../../framework/corpus.ts'
import { ENGINES, replayInvariants } from '../../framework/sessions.ts'

const RUNS = Number(process.env.PROPERTY_RUNS ?? 300)

for (const [name, create] of ENGINES) {
  describe(`${name} holds the book invariants on its own`, () => {
    it('over random trading sessions', () => {
      assertSessions(commandSequence(60), (commands) => replayInvariants(create, commands), {
        runs: RUNS,
        foundBy: `qe/suites/property/book-invariants.test.ts, ${name}`,
      })
    })
  })
}
