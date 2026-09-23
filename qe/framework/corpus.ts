/**
 * Saved counterexamples.
 *
 * When a property test finds a failure, fast-check shrinks it to a minimal
 * sequence. That sequence is worth far more than the run that found it: a
 * random search that hit a bug once is not guaranteed to hit it again, and the
 * next person to change that code deserves a deterministic test rather than a
 * probability.
 *
 * So every counterexample is written here and replayed on every pull request.
 * Replaying costs microseconds. Raising `numRuns` to improve the odds of
 * rediscovering the same case costs seconds on every pull request forever, and
 * still only improves the odds.
 *
 * The entries are also documentation. Each one is a named sequence of orders
 * that once broke something, with the reason attached, which describes the
 * system's history better than a changelog does.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import type { OrderRequest } from '../../spec/types.ts'

const CORPUS_PATH = 'qe/corpus/counterexamples.json'

export interface CounterexampleAction {
  readonly trader: number
  readonly isBuy: boolean
  readonly price: string
  readonly quantity: string
}

export interface Counterexample {
  readonly id: string
  /** What broke, in one line. */
  readonly summary: string
  /** Which suite found it, so a failure points at the right place. */
  readonly foundBy: string
  /** Market parameters, because some bugs only exist on some markets. */
  readonly market: {
    readonly quoteScale: string
    readonly baseScale: string
    readonly makerFeeBps: string
    readonly takerFeeBps: string
  }
  readonly actions: readonly CounterexampleAction[]
  /** Where the fix and the analysis live. */
  readonly reference: string
}

/** Stored as strings because JSON cannot hold a bigint. */
export function loadCorpus(): Counterexample[] {
  return JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as Counterexample[]
}

export function saveCounterexample(entry: Counterexample): void {
  const corpus = loadCorpus()
  if (corpus.some((existing) => existing.id === entry.id)) return
  corpus.push(entry)
  writeFileSync(CORPUS_PATH, `${JSON.stringify(corpus, null, 2)}\n`)
}

export function toOrderRequest(
  action: CounterexampleAction,
  index: number,
): OrderRequest {
  return {
    id: `c${index}`,
    accountId: `t${action.trader}`,
    side: action.isBuy ? 'buy' : 'sell',
    type: 'limit',
    tif: 'GTC',
    price: BigInt(action.price),
    quantity: BigInt(action.quantity),
    displayQuantity: null,
    postOnly: false,
    reduceOnly: false,
    triggerPrice: null,
    stpMode: 'none',
  }
}
