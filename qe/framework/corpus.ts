/**
 * Saved counterexamples.
 *
 * When a property test finds a failure, fast-check shrinks it to a minimal
 * sequence. That sequence is worth far more than the run that found it: a
 * random search that hit a bug once is not guaranteed to hit it again, and the
 * next person to change that code deserves a deterministic test rather than a
 * probability.
 *
 * So counterexamples are written here, by the nightly run or by hand, and
 * replayed on every pull request.
 * Replaying costs microseconds. Raising `numRuns` to improve the odds of
 * rediscovering the same case costs seconds on every pull request forever, and
 * still only improves the odds.
 *
 * The entries are also documentation. Each one is a named sequence of orders
 * that once broke something, with the reason attached, which describes the
 * system's history better than a changelog does.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import fc from 'fast-check'
import type { Lots, OrderRequest, Ticks } from '../../spec/types.ts'
import type { Command } from './commands.ts'
import type { SessionFailure } from './sessions.ts'

const CORPUS_PATH = 'qe/corpus/counterexamples.json'

export interface CounterexampleAction {
  readonly trader: number
  readonly isBuy: boolean
  readonly price: string
  readonly quantity: string
}

interface CounterexampleCommon {
  readonly id: string
  /** What broke, in one line. */
  readonly summary: string
  /** Which suite found it, so a failure points at the right place. */
  readonly foundBy: string
  /** Where the fix and the analysis live. */
  readonly reference: string
}

/**
 * Limit orders on a market, the shape the contract can also replay. The
 * consistency suite found these, and they settle through the ledger.
 */
export interface MarketCounterexample extends CounterexampleCommon {
  readonly kind?: 'market'
  /** Market parameters, because some bugs only exist on some markets. */
  readonly market: {
    readonly quoteScale: string
    readonly baseScale: string
    readonly makerFeeBps: string
    readonly takerFeeBps: string
  }
  readonly actions: readonly CounterexampleAction[]
}

/**
 * A full engine session, every order type included. The engine property
 * suites found these, and they replay through both engines.
 */
export interface SessionCounterexample extends CounterexampleCommon {
  readonly kind: 'session'
  readonly commands: readonly EncodedCommand[]
}

export type Counterexample = MarketCounterexample | SessionCounterexample

/** A Command with its bigints as decimal strings, because JSON has no bigint. */
export type EncodedCommand =
  | { readonly kind: 'cancel'; readonly targetIndex: number }
  | {
      readonly kind: 'submit'
      readonly request: Omit<OrderRequest, BigintField> & Record<BigintField, string | null>
    }

type BigintField = 'price' | 'quantity' | 'triggerPrice' | 'displayQuantity'

export function encodeCommand(command: Command): EncodedCommand {
  if (command.kind === 'cancel') return command
  const r = command.request
  const str = (v: bigint | null): string | null => (v === null ? null : v.toString())
  return {
    kind: 'submit',
    request: {
      ...r,
      price: str(r.price),
      quantity: r.quantity.toString(),
      triggerPrice: str(r.triggerPrice),
      displayQuantity: str(r.displayQuantity),
    },
  }
}

export function decodeCommand(command: EncodedCommand): Command {
  if (command.kind === 'cancel') return command
  const r = command.request
  const big = (v: string | null): bigint | null => (v === null ? null : BigInt(v))
  return {
    kind: 'submit',
    request: {
      ...r,
      price: big(r.price) as Ticks | null,
      quantity: BigInt(r.quantity!) as Lots,
      triggerPrice: big(r.triggerPrice) as Ticks | null,
      displayQuantity: big(r.displayQuantity) as Lots | null,
    },
  }
}

export function loadCorpus(): Counterexample[] {
  return JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as Counterexample[]
}

/**
 * Run a property over generated sessions. On failure, save the shrunk session
 * to the corpus when SAVE_COUNTEREXAMPLES=1, then fail with the report.
 *
 * Saving is opt-in. The nightly job turns it on and opens an issue with the
 * new entry, so a person reads it before it becomes a permanent test. A local
 * run leaves the working tree alone.
 */
export function assertSessions(
  sessions: fc.Arbitrary<Command[]>,
  replay: (commands: readonly Command[]) => SessionFailure | null,
  options: { readonly runs: number; readonly foundBy: string },
): void {
  const details = fc.check(
    fc.property(sessions, (commands) => replay(commands) === null),
    { numRuns: options.runs },
  )
  if (!details.failed) return

  const [shrunk] = details.counterexample ?? [[]]
  let failure: SessionFailure
  try {
    failure = replay(shrunk) ?? { index: shrunk.length - 1, message: String(details.errorInstance) }
  } catch (error) {
    // The engine threw rather than disagreeing. That is a failure too, and the
    // session that provokes it is just as worth keeping.
    failure = { index: shrunk.length - 1, message: `threw: ${String(error)}` }
  }
  const commands = shrunk.slice(0, failure.index + 1)

  let saved = ''
  if (process.env.SAVE_COUNTEREXAMPLES === '1') {
    const encoded = commands.map(encodeCommand)
    const id = `session-${createHash('sha256').update(JSON.stringify(encoded)).digest('hex').slice(0, 12)}`
    saveCounterexample({
      kind: 'session',
      id,
      summary: failure.message.split('\n')[0]!,
      foundBy: options.foundBy,
      reference: 'unanalysed: found by the nightly run, needs a person',
      commands: encoded,
    })
    saved = `\n\nSaved to ${CORPUS_PATH} as ${id}.`
  }

  throw new Error(
    `${failure.message}\n\nfast-check seed ${details.seed}, path ${details.counterexamplePath}.${saved}`,
  )
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
