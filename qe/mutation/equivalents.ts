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
  // ---- min/abs/comparator helpers: the mutated case is the equal case ----
  {
    file: 'sut/backend/engine/matching-engine.ts',
    source: 'const minOf = (a: bigint, b: bigint): bigint => (a < b ? a : b)',
    mutator: 'cmp-lt-lte',
    argument:
      'The two branches differ only when a equals b, and when they are equal ' +
      'both branches return the same value. No input can distinguish them.',
  },
  {
    file: 'qe/model/reference-engine.ts',
    source: 'const min = (a: bigint, b: bigint): bigint => (a < b ? a : b)',
    mutator: 'cmp-lt-lte',
    argument: 'Same as minOf in the production engine: the branches agree when a equals b.',
  },
  {
    file: 'qe/model/reference-engine.ts',
    source: 'const abs = (a: bigint): bigint => (a < 0n ? -a : a)',
    mutator: 'cmp-lt-lte',
    argument:
      'The branches differ only at zero, and -0n equals 0n for bigint. Both ' +
      'return zero.',
  },
  {
    file: 'qe/model/reference-engine.ts',
    source: 'const cmpAsc = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0)',
    mutator: 'cmp-lt-lte',
    argument:
      'cmpAsc is only ever reached from the price comparator, which guards ' +
      'with `if (pa !== pb)` before calling it. Equal prices never arrive, so ' +
      'the branch the mutation changes is unreachable. Worth noting that this ' +
      'is equivalence by caller, not by the function itself: if cmpAsc is ' +
      'called from anywhere else, this entry becomes wrong.',
  },
  {
    file: 'qe/model/reference-engine.ts',
    source: 'const cmpAsc = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0)',
    mutator: 'cmp-gt-gte',
    argument: 'Same reachability argument as the cmp-lt-lte mutation on this line.',
  },

  // ---- guarded by an earlier early return ----
  {
    file: 'sut/backend/engine/matching-engine.ts',
    source: "const reducesLong = r.side === 'sell' && position > 0n",
    mutator: 'cmp-gt-gte',
    argument:
      'A zero position returns reduce_only_no_position three lines earlier, so ' +
      'position is never zero here and > and >= cannot differ.',
  },
  {
    file: 'sut/backend/engine/matching-engine.ts',
    source: "const reducesShort = r.side === 'buy' && position < 0n",
    mutator: 'cmp-lt-lte',
    argument: 'Same early return on a zero position makes the boundary unreachable.',
  },
  {
    file: 'sut/backend/engine/matching-engine.ts',
    source: 'const cap = position < 0n ? -position : position',
    mutator: 'cmp-lt-lte',
    argument: 'Zero is excluded by the earlier return, and -0n equals 0n regardless.',
  },
  {
    file: 'qe/model/reference-engine.ts',
    source: "const reducesLong = r.side === 'sell' && position > 0n",
    mutator: 'cmp-gt-gte',
    argument: 'Same early return on a zero position as the production engine.',
  },
  {
    file: 'qe/model/reference-engine.ts',
    source: "const reducesShort = r.side === 'buy' && position < 0n",
    mutator: 'cmp-lt-lte',
    argument: 'Same early return on a zero position as the production engine.',
  },

  // ---- the mutated branch produces an identical value ----
  {
    file: 'sut/backend/engine/matching-engine.ts',
    source: 'return r.quantity <= cap ? { request: r } : { request: { ...r, quantity: cap } }',
    mutator: 'cmp-lte-lt',
    argument:
      'When quantity equals cap the two branches build equal objects: capping ' +
      'to a value the order already has changes nothing.',
  },
  {
    file: 'qe/model/reference-engine.ts',
    source: 'if (r.quantity <= cap) return { request: r }',
    mutator: 'cmp-lte-lt',
    argument:
      'At quantity equals cap, falling through returns the request with ' +
      'quantity set to cap, which is the value it already had.',
  },
  {
    file: 'sut/backend/engine/matching-engine.ts',
    source: 'if (total >= r.quantity) return total',
    mutator: 'cmp-gte-gt',
    argument:
      'An early exit from an accumulation loop. Leaving one iteration later ' +
      'returns a total that is at least as large, and the only caller compares ' +
      'it against the same quantity, so the comparison result is unchanged.',
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

/**
 * Whether this exact mutant, operator included, is argued equivalent above.
 *
 * Matching on the line alone excused every mutant on a listed line. The
 * reduce-only lines are listed for their `>`/`<` boundary, and that silently
 * dropped the `===` and `&&` mutants on the same lines from the score too, all
 * eight of them killable. An argument covers one mutant, not a line.
 */
export function isKnownEquivalent(site: MutantSite): boolean {
  return EQUIVALENT_MUTANTS.some(
    (known) =>
      known.file === site.file &&
      known.source === site.original &&
      known.mutator === site.mutator.id,
  )
}
