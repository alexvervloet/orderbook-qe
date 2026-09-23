# orderbook-qe

A quality engineering system built from zero for an onchain order-book
exchange, with the exchange included as the thing under test.

The repository is two halves that were written to be independent. `sut/` is an
exchange: a matching engine, a REST, WebSocket and JSON-RPC service, a Solidity
order book that settles onchain, and a thin trading UI. `qe/` is the deliverable:
the testing architecture, the automation, the tooling and the decisions behind
them.

## What it found

The harness has found **three defects I did not plant**. They are the reason to
read any of the rest.

**Partial fills could permanently strand a trader's funds.** Fees were escrowed
once on an order total and released per fill, and `ceil(a+b)` is not
`ceil(a)+ceil(b)`, so releasing every fill eventually tried to release more
escrow than was ever taken. The order then could not be filled or cancelled.
Invisible to 23 Solidity unit tests, three fuzz tests and eight invariants,
because the default market's numbers divide evenly and made the bug unreachable.
Found by differential testing against a market whose fees do not divide evenly.

**An unfunded account could destroy a maker's liquidity.** The exchange matched
first and settled second. An account with no money consumed a resting order, the
book changed, positions moved, settlement threw, and the ledger never moved. The
maker lost their order for a trade that did not happen. Found by an end-to-end
test, then rewritten as an integration test that runs in four milliseconds.

**An unpriceable order panicked instead of refusing.** An arithmetic overflow
before the balance check, so integrators could not tell "too large to price"
from "this exchange is broken".

Each one, the cause, and the test that now catches it:
[docs/FAILURE-MODES.md](docs/FAILURE-MODES.md).

## The idea the repository is built on

If the same person writes the exchange and its tests, "my tests found my bugs"
proves nothing. Two things remove the circularity.

**A reference implementation as an oracle.** `qe/model/reference-engine.ts` is a
naive, deliberately slow matching engine, written from the specification and
correct by inspection. The engine in `sut/` is the real one, with price-level
maps, intrusive linked lists and O(1) cancel. Property tests drive random order
sequences through both and compare every observable after every command.

Two of six seeded defects were invisible to 106 hand-written tests and caught
immediately by this. Both were cached aggregates, exactly the thing nobody
writes an assertion about.

**Mutation score instead of coverage.** Not "I planted twelve bugs and found
twelve", but a kill rate against machine-generated mutants, with equivalent
mutants registered and argued rather than quietly counted.

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
  suites/      unit | property | contract | integration | consistency | e2e | perf
  mutation/    mutation harness, equivalent-mutant registry
  ai/          AI generation and triage, with scoring
docs/        the decisions
```

`spec/` is shared; the two implementations are not. That is what makes a
differential test between them mean anything.

## Running it

```bash
npm install
npm test                 # unit, property, contract, integration, consistency
npm run test:e2e         # Playwright, needs a browser
cd sut/contracts && forge test
docker compose up backend
```

The consistency suite spawns a real Anvil node and deploys the real bytecode, so
Foundry must be installed and the contracts built.

## The suites, and what each is for

| Suite | What it covers | Cost |
| --- | --- | --- |
| Unit | One conformance suite, run against both engines | 0.5s |
| Property | Differential against the oracle; value conservation | 0.7s |
| Contract | REST, WebSocket and JSON-RPC against published schemas | 0.7s |
| Integration | Matching and settlement cannot disagree | 0.2s |
| Consistency | Offchain engine against the Solidity contract | 3.6s |
| Solidity | Units, fuzz, and eight invariants over a handler | 1.0s |
| E2E | Browser against backend, six cases only | 2.4s |
| Performance | k6 load, stress and latency against budgets | minutes |

Timings are measured, not estimated, and reproducible with `npm run ci:timings`.

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
happened. It now separates a panic from a deliberate refusal.

## CI

Every pull request runs everything deterministic in about 55 seconds, against a
five-minute budget. Nightly runs the searching work: deep property runs, the
consistency suite across both markets, mutation testing, load and chaos.

The reasoning, and the measured cost of each tier:
[docs/CI-POLICY.md](docs/CI-POLICY.md).

## AI in the workflow

Two tracks, both scored, because "we use AI" is unfalsifiable.

**Failure triage.** A model classifies real failures into the categories that
decide what happens next, graded against labels assigned by hand once the cause
was known. Haiku 4.5 gets 9 of 12; Sonnet 5 gets 8 of 12 at 2.4x the price. Both
are perfect on the category that matters most and both fail the same way at the
edges. One model's confidence score is anti-correlated with being right.

**Test generation**, scored by the mutation kill rate of what it produces rather
than by whether it looks reasonable.

Numbers, method, and what did not work:
[docs/AI-IN-QE.md](docs/AI-IN-QE.md).

## The documents

The testing decisions are as much the deliverable as the tests.

- [docs/RISK-MAP.md](docs/RISK-MAP.md) — every trading path ranked by blast
  radius, detection difficulty and likelihood, and which 20 to 30 per cent get
  protected first
- [docs/NON-GOALS.md](docs/NON-GOALS.md) — what is deliberately not tested, the
  cost of each decision, and what would reverse it
- [docs/FAILURE-MODES.md](docs/FAILURE-MODES.md) — every defect found, planted
  or real, with the test that catches it
- [docs/CI-POLICY.md](docs/CI-POLICY.md) — pull request versus nightly, from
  measured timings
- [docs/FIRST-30-DAYS.md](docs/FIRST-30-DAYS.md) — how I would approach being
  the first quality engineer on a platform like this
- [docs/PRECISION.md](docs/PRECISION.md) — the integer discipline and the
  rounding rule
- [docs/TEST-DATA.md](docs/TEST-DATA.md) — seed data, generation, environments
- [docs/MUTATION.md](docs/MUTATION.md) — how to read a surviving mutant
- [spec/SEMANTICS.md](spec/SEMANTICS.md) — the matching behaviour both engines
  implement, written before either
- [LESSONS.md](LESSONS.md) — everything that went wrong while building this

[LESSONS.md](LESSONS.md) is the one I would read second. A suite that was green
because its generator produced six-command sessions. An invariant suite that
passed by swallowing the failure. A mutation runner that hung for fifty minutes
with a mutant in the working tree. Each one is a way a test suite can look
healthy and be measuring nothing.

## Scope

This is a testbed, not a product. The exchange is real enough to have real bugs
and deliberately narrower than a production platform: no perpetuals, no margin,
no liquidation, and the onchain contract implements good-till-cancelled limit
orders only, with the richer order types resolved offchain. The boundaries and
the reasons are in [docs/NON-GOALS.md](docs/NON-GOALS.md).
