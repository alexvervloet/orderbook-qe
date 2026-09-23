/**
 * Mutants that cannot be killed, with the argument for why.
 *
 * An equivalent mutant changes the source without changing behaviour, so no
 * test can detect it. Counting one as a survivor makes a suite look worse than
 * it is and sends someone chasing a test that cannot exist.
 *
 * Triage is human work and there is no way around that. What this file does is
 * make it work done once. Every entry states the reasoning, so the next person
 * to see the survivor reads an argument instead of rebuilding it.
 *
 * An entry is a claim that can be wrong. If behaviour later changes so that a
 * listed mutant does become observable, the entry is a bug.
 */
import type { MutantSite } from './mutators.ts'

export interface EquivalentMutant {
  readonly file: string
  /** Trimmed source line the mutant applies to. */
  readonly source: string
  readonly mutator: string
  readonly argument: string
}

export const EQUIVALENT_MUTANTS: readonly EquivalentMutant[] = [
  {
    file: 'sut/backend/engine/matching-engine.ts',
    source: 'if (!crosses(r, price)) break // prices are best-first, so nothing further can cross',
    mutator: 'break-to-continue',
    argument: [
      'Replacing break with continue skips the accumulation line rather than',
      'reaching it, and because the price array is sorted best-first, every',
      'price after the first non-crossing one also fails to cross. The loop',
      'therefore adds nothing either way and returns the same total by a slower',
      'route. Cost me an hour and a wrong conclusion; see LESSONS.md.',
    ].join(' '),
  },
  {
    file: 'sut/backend/ledger.ts',
    source: 'if (amount <= 0n) return',
    mutator: 'cmp-lte-lt',
    argument: [
      'The guard short-circuits a requirement for a non-positive amount. With',
      '<= the function returns for amount 0; with < it proceeds and evaluates',
      'held < 0, which is false for every balance because balances are never',
      'negative, so it also returns without throwing. Same behaviour, one extra',
      'comparison.',
    ].join(' '),
  },
]

export function isKnownEquivalent(site: MutantSite): boolean {
  return EQUIVALENT_MUTANTS.some(
    (known) => known.file === site.file && known.source === site.original,
  )
}
