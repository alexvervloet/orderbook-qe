# orderbook-qe

A quality engineering system built from zero for an onchain order-book
exchange, with the exchange included as the thing under test.

The repository is two halves that were written to be independent. `sut/` is an
exchange: a matching engine, a REST, WebSocket and JSON-RPC service, a Solidity
order book that settles onchain, and a thin trading UI. `qe/` is the deliverable:
the testing architecture, the automation, the tooling and the decisions behind
them.

## What it found

The harness has found defects I did not plant. They are the reason to read any
of the rest. Four of them:

**Partial fills could permanently strand a trader's funds.** Fees were escrowed
once on an order total and released per fill, and `ceil(a+b)` is not
`ceil(a)+ceil(b)`, so releasing every fill eventually tried to release more
escrow than was ever taken. The order then could not be filled or cancelled.
Invisible to every Solidity test, because the default market's numbers divide
evenly. Found by differential testing against a market whose fees do not. The
first fix then left a unit or two locked on every multi-lot fill, the same
lesson a second time.

**An unfunded account could destroy a maker's liquidity.** The exchange matched
first and settled second. An account with no money consumed a resting order, the
book changed, positions moved, settlement threw, and the ledger never moved. The
maker lost their order for a trade that did not happen. Found by an end-to-end
test, then rewritten as an integration test that runs in milliseconds. Stop
orders later turned out to skip the fix.

**Both engines agreed on a crossed book.** A stop triggered mid-order could rest
before the order that triggered it, and that order then rested straight through
it. The differential test compared the two engines, and both had the same bug,
so thousands of runs passed. A property that checks the book with no oracle
failed on its first run.

**An unpriceable order panicked instead of refusing.** An arithmetic overflow
before the balance check, so integrators could not tell "too large to price"
from "this exchange is broken". The fix missed the case where the notional fits
and the notional plus its fee escrow does not, which a mutation-testing
survivor led to.

All ten, the cause of each, and the test that now catches it:
[docs/FAILURE-MODES.md](docs/FAILURE-MODES.md).

## The ideas the repository is built on

If the same person writes the exchange and its tests, "my tests found my bugs"
proves nothing. Three things push against that.

**A reference implementation as an oracle.** `qe/model/reference-engine.ts` is a
naive, deliberately slow matching engine, written from the specification and
meant to be checked line by line against it. The engine in `sut/` is the real
one, with price-level maps, intrusive linked lists and O(1) cancel. Property
tests drive random order sequences through both and compare every observable
after every command. Two of six seeded defects were invisible to the 106
hand-written tests of the time and caught immediately by this. Both were cached
aggregates, exactly the thing nobody writes an assertion about.

**Invariants that need no oracle.** An oracle only tells you two
implementations agree. When the same person writes both from the same spec,
they can agree on something wrong, and here they did. So the rules the spec
states in one sentence, like "the book is never crossed at rest", are also
checked on each engine alone.

**Mutation score instead of coverage.** A kill rate against machine-generated
mutants: currently 237 of 238, with 19 equivalent mutants excluded, each argued
in `qe/mutation/equivalents.ts`, and one survivor left standing and explained.
This used to read 258 of 258, and that number was inflated three different
ways. What the score means, what it does not, and what inflated it:
[docs/MUTATION.md](docs/MUTATION.md).

## How the pieces check each other

```
                      spec/SEMANTICS.md, spec/LEDGER.md
                                     |
             +-----------------------+------------------------+
             |                                                |
   qe/model/reference-engine.ts                 sut/backend/engine (production)
   slow, obvious, the oracle                    fast, the system under test
             |                                                |
             +------- differential property tests -----------+
                      (every observable, after every command)
                                     |
                book invariants on each engine alone (no oracle)
                                     |
   sut/backend/ledger.ts  <--- consistency suite, on a local chain --->  sut/contracts
   offchain settlement         (same orders, compare balances)          onchain settlement
                                     |
                 REST, WebSocket, JSON-RPC contract tests, then the browser
```

`spec/` is shared; the two implementations are not. That is what makes a
differential test between them mean anything, and also why it is not enough on
its own.

## Layout

```
spec/        the written contract: matching semantics, ledger rules, types
sut/         the system under test
  contracts/   Solidity order book and settlement (Foundry)
  backend/     matching engine, ledger, REST + WebSocket + JSON-RPC
  frontend/    thin trading UI
qe/          the quality engineering system
  model/       the reference engine
  framework/   builders, harnesses, chain fixtures, differential comparison
  suites/      unit | property | contract | integration | consistency | chaos | e2e | perf
  corpus/      saved counterexamples, replayed on every pull request
  mutation/    mutation runner, equivalent-mutant registry
  tools/       flake detection, the skip gate, CI timings
  select/      changed files to affected suites, advisory for now
  ai/          AI triage and test generation, with scoring
docs/        the decisions
```

## Running it

Prerequisites: Node 22.6 or later (CI uses 24), and [Foundry](https://getfoundry.sh) v1.8.3
for the contract and every suite that deploys it. Docker and
[k6](https://k6.io) are only needed for the chaos and performance suites.

```bash
git submodule update --init          # forge-std
npm install
(cd sut/contracts && forge build)    # the consistency and chaos suites deploy this bytecode

npm test                             # 228 tests; 5 network chaos tests skip without Toxiproxy
(cd sut/contracts && forge test)     # 44 Solidity unit, fuzz and invariant tests
npx playwright install chromium && npm run test:e2e

docker compose --profile chaos up -d --wait
REQUIRE_TOXIPROXY=1 npm run test:chaos    # the network tests, for real

npm run mutate                       # tens of minutes; writes qe/mutation/reports/
npm run flake:detect                 # ten runs of each runner
```

## The suites, and what each is for

| Suite | What it covers | Cost |
| --- | --- | --- |
| Unit | One conformance suite, run against both engines | 0.5s |
| Property | Differential against the oracle, invariants with no oracle, value conservation, the corpus | 0.7s |
| Contract | REST, WebSocket and JSON-RPC against published schemas | 0.7s |
| Integration | Matching and settlement cannot disagree | 0.6s |
| Consistency | Offchain engine and ledger against the Solidity contract | 4.1s |
| Solidity | Units, fuzz, and nine invariants over a handler, on two markets | 1.3s |
| Chaos | Reorg detection, network faults under Toxiproxy | 3s plus compose |
| E2E | Browser against backend, six cases only | 2.5s |
| Performance | k6 load, stress and latency nightly, soak weekly | minutes to hours |

Measured, and remeasured with `npm run ci:timings`; the full table is in
[docs/CI-POLICY.md](docs/CI-POLICY.md).

A few that are worth looking at specifically:

**The feed reconstruction test.** Apply every WebSocket delta to the opening
snapshot and require the result to equal a freshly fetched book. One assertion
covers a family of bugs that would otherwise need a test each.

**Integers above 2^53.** `JSON.parse` silently turns `9007199254740993` into
`...992`. On an exchange that is a fill nobody asked for. Every integer crosses
the wire as a decimal string, and a test round-trips a value that proves it.

**Invariants over a handler that does not lie.** The first version passed with a
deliberately broken contract, because its `catch` absorbed every revert the
break caused and the invariants were then checked on a book where nothing had
happened. It now separates a panic from a deliberate refusal, and requires every
locked unit to belong to an order that is still open.

## CI

Every pull request runs everything deterministic in under a minute of wall
clock, against a five-minute budget, and fails if any test was skipped outside
a short allowlist. Nightly runs the searching work: deep property runs that
file new counterexamples as issues, the consistency suite at depth, mutation
testing, flake detection across both test runners, chaos under Toxiproxy, and
load. Weekly runs a four-hour soak that fails on latency drift.

The reasoning, and the measured cost of each tier:
[docs/CI-POLICY.md](docs/CI-POLICY.md).

## AI in the workflow

Two tracks, both scored, because "we use AI" is unfalsifiable.

**Failure triage.** A model classifies real failures into the categories that
decide what happens next, graded against labels assigned by hand once the cause
was known. Haiku 4.5 and Sonnet 5 both get 7 of 10, Sonnet at 2.4x the price,
and Sonnet made the one dangerous mistake: it called a real product bug a test
bug. Neither can recognise an equivalent mutant, and one model's confidence
score is anti-correlated with being right. An earlier version of the corpus
included two failures I had invented rather than hit; they are gone, and the
page says what that changed.

**Test generation**, scored by the mutation kill rate of what it produces rather
than by whether it looks reasonable. On the ledger, a generated suite killed 7
of 9 mutants against the hand-written suite's 9 of 9, for $0.23 and two repair
rounds. Both misses were on the guards that refuse bad input, and both were
missing from the hand-written suite too until mutation testing pointed at them.

Numbers, method, and what did not work:
[docs/AI-IN-QE.md](docs/AI-IN-QE.md).

## The documents

The testing decisions are as much the deliverable as the tests.

- [docs/RISK-MAP.md](docs/RISK-MAP.md). Every trading path ranked by blast
  radius, detection difficulty and likelihood, and which third get protected
  first.
- [docs/NON-GOALS.md](docs/NON-GOALS.md). What is deliberately not tested, the
  cost of each decision, and what would reverse it.
- [docs/FAILURE-MODES.md](docs/FAILURE-MODES.md). Every defect found, planted
  or real, with the test that catches it.
- [docs/CI-POLICY.md](docs/CI-POLICY.md). Pull request, nightly and weekly,
  from measured timings.
- [docs/FIRST-30-DAYS.md](docs/FIRST-30-DAYS.md). How I would approach being
  the first quality engineer on a platform like this.
- [docs/PRECISION.md](docs/PRECISION.md). The integer discipline and the
  rounding rule.
- [docs/TEST-DATA.md](docs/TEST-DATA.md). Seed data, generation, environments.
- [docs/MUTATION.md](docs/MUTATION.md). How to read a surviving mutant, and
  why the score used to be wrong.
- [spec/SEMANTICS.md](spec/SEMANTICS.md). The matching behaviour both engines
  implement.
- [LESSONS.md](LESSONS.md). Everything that went wrong while building this.

[LESSONS.md](LESSONS.md) is the one I would read second. A suite that was green
because its generator produced six-command sessions. An invariant suite that
passed by swallowing the failure. A flake detector that never read a result. A
mutation score that counted syntax errors as kills. Each one is a way a test
suite can look healthy and be measuring nothing.

## Scope

This is a testbed, not a product. The exchange is real enough to have real bugs
and deliberately narrower than a production platform: no perpetuals, no margin,
no liquidation, and the onchain contract implements good-till-cancelled limit
orders only, with the richer order types resolved offchain. The boundaries and
the reasons are in [docs/NON-GOALS.md](docs/NON-GOALS.md).
