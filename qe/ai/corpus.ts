/**
 * Labelled failure corpus for scoring AI triage.
 *
 * Every entry is a failure that really happened while building this repository,
 * with the label assigned by hand afterwards, once the cause was known. That
 * matters: a corpus of invented failures measures how well a model recognises
 * the kind of failure a person thinks to invent, which is not the question.
 *
 * It did not always hold. Two invented entries, a port collision and an empty
 * price level after a cancel, sat here for the first scored runs, described as
 * real. They were removed, and the published scores were recomputed from the
 * per-case verdicts on the ten real failures. See docs/AI-IN-QE.md.
 *
 * The labels are the taxonomy that decides what happens next, which is the only
 * useful thing a triage step can produce:
 *
 *   product-bug     the system under test is wrong. Fix the system.
 *   test-bug        the test is wrong; the system is fine. Fix the test.
 *   test-equipment  the harness, generator or fixture is wrong, so the suite is
 *                   not exercising what it claims. Fix the equipment, and treat
 *                   every green run since it broke as unproven.
 *   environment     nothing is wrong with either; the environment misbehaved.
 *   equivalent      a mutation that cannot change behaviour. No action.
 *
 * `test-equipment` is separated from `test-bug` on purpose. A broken assertion
 * fails loudly. Broken equipment passes, which is far worse, and the response
 * is different: you have to go back and distrust earlier results.
 */

export type FailureLabel =
  | 'product-bug'
  | 'test-bug'
  | 'test-equipment'
  | 'environment'
  | 'equivalent'

export interface LabelledFailure {
  readonly id: string
  /** What the engineer actually sees: output, timings, symptoms. */
  readonly evidence: string
  readonly label: FailureLabel
  /** Why that label, recorded when the cause was established. */
  readonly rationale: string
}

export const FAILURE_CORPUS: readonly LabelledFailure[] = [
  {
    id: 'escrow-underflow',
    evidence: [
      'Suite: offchain/onchain consistency, awkward-scale market (quoteScale 3).',
      'Property failed after 5 tests. Shrunk 16 times.',
      'Counterexample: [sell 1@98, buy 2@99, sell 1@98, sell 1@98] all from trader 0.',
      'AssertionError: expected [ { price: 99n, quantity: 1n } ] to deeply equal []',
      'The third order succeeded offchain and reverted onchain with an arithmetic panic.',
      'The same sequence passes on the default market (quoteScale 10000).',
    ].join('\n'),
    label: 'product-bug',
    rationale:
      'Fee escrow was taken once on the order total and released per fill, and ' +
      'ceil(a+b) is not ceil(a)+ceil(b). The contract strands funds. Real defect.',
  },
  {
    id: 'notional-overflow-panic',
    evidence: [
      'Suite: forge test, OrderBookExchangeTest.',
      '[FAIL: Error != expected error: panic: arithmetic underflow or overflow (0x11)',
      ' != InsufficientBalance()] test_PlacingBeyondBalanceReverts()',
      'Called placeLimitOrder(true, type(uint128).max, type(uint128).max).',
    ].join('\n'),
    label: 'product-bug',
    rationale:
      'quantity * price * quoteScale overflows before the balance check, so the ' +
      'caller gets a panic instead of a reason. Nothing is at risk but the ' +
      'contract owes integrators a named error.',
  },
  {
    id: 'generator-length-bias',
    evidence: [
      'Suite: differential property test.',
      'PASS. 2 tests, 30ms, for what should be 360 sessions of up to 40 commands.',
      'Instrumentation: 300 sessions produced 1828 commands total and 214 trades.',
      'fc.array was configured { minLength: 1, maxLength: 40 }.',
    ].join('\n'),
    label: 'test-equipment',
    rationale:
      "fast-check's array generator is biased toward short arrays. The suite was " +
      'green because it was barely generating anything, not because the engine ' +
      'was right. Every previous green run on this suite is unproven.',
  },
  {
    id: 'invariant-handler-swallows-reverts',
    evidence: [
      'Suite: forge invariant, OrderBookInvariantTest.',
      'All 8 invariants PASS. reverts: 0. placeOrder called 398 times.',
      'This is with a deliberate mutation removing the limit-price check from',
      'the matching loop, which should let a buy at 90 trade against an ask at 110.',
    ].join('\n'),
    label: 'test-equipment',
    rationale:
      "The handler's catch-all absorbed every revert the mutation caused, so the " +
      'invariants were evaluated on a book where nothing had happened. reverts: 0 ' +
      'counts only reverts that escape the handler.',
  },
  {
    id: 'replay-shape-mismatch',
    evidence: [
      'Suite: WebSocket contract, reconnect test.',
      'AssertionError: expected Map { "99" => { orderCount: 1, price: "99", quantity: "7" } }',
      'to deeply equal Map { "99" => { orderCount: 1, quantity: "7" } }',
      'The backend and the fetched book agree; only the replayed map differs.',
    ].join('\n'),
    label: 'test-bug',
    rationale:
      'The replay helper stored the whole level object including price on the ' +
      'snapshot path and only quantity and count on the delta path. The system ' +
      'under test is fine.',
  },
  {
    id: 'precision-assertion-inverted',
    evidence: [
      'Suite: REST contract.',
      'AssertionError: expected 9007199254740992 not to be 9007199254740992',
      'The preceding assertion, that the response field equals "9007199254740993",',
      'passed.',
    ].join('\n'),
    label: 'test-bug',
    rationale:
      'Number("9007199254740993") really is 9007199254740992; that is the loss the ' +
      'string encoding prevents. The assertion asserted the opposite of what it meant.',
  },
  {
    id: 'viem-polling-timeout',
    evidence: [
      'Suite: offchain/onchain consistency.',
      'Error: Hook timed out in 60000ms. beforeAll deploying contracts.',
      'Run standalone, the same setup completes in 60422ms.',
      'Anvil itself starts and answers getBlockNumber in 206ms.',
      'Setup performs 15 transactions.',
    ].join('\n'),
    label: 'environment',
    rationale:
      "viem's default pollingInterval is 4000ms and Anvil mines instantly. " +
      '15 transactions times one 4s tick is the 60s. Neither the contract nor the ' +
      'test logic is wrong; the client was configured for a public network.',
  },
  {
    id: 'break-to-continue-fillability',
    evidence: [
      'Mutation: sut/backend/engine/matching-engine.ts, break becomes continue',
      'in the FOK fillability scan.',
      'Survived the unit suite (106 tests) and the differential suite at 400 and',
      'at 5000 runs.',
    ].join('\n'),
    label: 'equivalent',
    rationale:
      'continue skips the accumulation line, and the price array is sorted ' +
      'best-first, so no later price crosses either. Same result, slower. ' +
      'No test can kill it.',
  },
  {
    id: 'coverage-check-as-invariant',
    evidence: [
      'Suite: forge invariant.',
      '[FAIL: no order was ever placed: 0 <= 0] invariant_TheRunDidRealWork',
      'Fails on the unmodified contract, on every run, immediately.',
    ].join('\n'),
    label: 'test-bug',
    rationale:
      'Foundry evaluates invariants after every call including the first, when no ' +
      'order has been placed. A statement about a finished run is not an ' +
      'invariant; it belongs in afterInvariant.',
  },
  {
    id: 'ledger-conservation-blind-to-counterparty',
    evidence: [
      'Mutation: sut/backend/ledger.ts line 111, === becomes !== in the buyer',
      'assignment, making buyer and seller the same account.',
      'Survived every ledger conservation property at 300 runs.',
    ].join('\n'),
    label: 'test-bug',
    rationale:
      'Conservation is satisfied by moving nothing. The suite asserted that totals ' +
      'were unchanged but never that the two counterparties moved in opposite ' +
      'directions. A gap in the tests, not a defect in the ledger.',
  },
]

export function corpusById(id: string): LabelledFailure {
  const found = FAILURE_CORPUS.find((f) => f.id === id)
  if (found === undefined) throw new Error(`no corpus entry ${id}`)
  return found
}
