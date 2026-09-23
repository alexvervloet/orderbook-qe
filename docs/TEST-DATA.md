# Test data and environments

## One definition of seed data

Seed accounts live in `sut/backend/seed.ts` and nowhere else. The container uses
them, the load tests trade against them, and the end-to-end tests drive them.

The alternative, a setup script plus a fixture that happen to agree, does not
stay agreeing. When they drift, the failure looks like a product bug, and it is
the most expensive kind to debug because everything you are looking at is
correct.

## What is seeded

Four funded accounts, two intended as makers and two as takers, and **one
account with nothing in it**.

The unfunded account matters more than the funded ones. A fixture where everyone
can afford everything never exercises the rejection path, and rejection is where
an exchange either protects itself or corrupts its own book. This repository
shipped a bug where an unfunded order consumed a maker's resting liquidity, and
the reason it was not caught earlier is that every fixture was rich. See
[FAILURE-MODES.md](FAILURE-MODES.md).

Balances are large enough that no test runs out, and round enough that an
unexpected number is obvious at a glance.

## Generated data

Anything beyond the fixed accounts is generated, never hand-written.

`qe/framework/commands.ts` produces random trading sessions, and it is tuned
rather than uniform. Prices sit in a narrow band so orders actually cross,
accounts are few so self-trades are common, and cancels target orders that were
really submitted. Every order shape is generated with every time in force, since
the combinations are where the spec spends its words. A uniform generator over
the same space spends almost all its time on empty books and finds nothing.

The generator is test equipment and needs calibrating like any other instrument.
Measured once, 300 sessions produced about 8,100 commands and 2,300 trades,
before the generator was widened. When numbers like those fall, the suite has
stopped testing something, whether or not it is still green. That is not
hypothetical; see [../LESSONS.md](../LESSONS.md). Nothing counts them on every
run yet, and it should.

## Counterexamples are data too

A failing case a property test finds is shrunk and can be written to
`qe/corpus/`, where it is replayed on every pull request. The nightly job writes
them automatically and files each as an issue; a person commits it once the
cause is understood. A random search that found a bug once will not necessarily
find it again; the corpus makes it deterministic, and it costs milliseconds
compared with raising the run count. Entries are either limit-order sessions on
a market, which both the offchain side and the contract can replay, or full
engine sessions with every order type.

## Environments

Three compose profiles, so each use starts only what it needs. The consistency
and reorg suites do not use them: each test file spawns its own Anvil.

| Command | Contains | For |
| --- | --- | --- |
| `docker compose up backend` | API and UI | contract, E2E, load |
| `docker compose --profile chain up` | plus Anvil | working against the contract by hand |
| `docker compose --profile chaos up` | plus Toxiproxy | fault injection |

Everything a test process starts for itself binds to an ephemeral port: the
contract-test server and the Anvil node each test file spawns. A fixed port is a
flaky test waiting for a parallel run, and the fix is an ephemeral port rather
than a retry. The long-lived services are the exception, on fixed ports because
something outside the test has to find them: compose publishes 8080, 8545, 8474
and 8666, each movable with an environment variable, and Playwright's server
listens on 8099.

## Resetting between tests

By isolation, not by cleanup.

- Unit, property and integration tests construct a fresh engine per test. There
  is nothing to reset.
- Contract tests start a server on an ephemeral port per file.
- Onchain tests take an Anvil snapshot before each case and revert after, which
  is faster than redeploying and cannot leave residue behind.
- End-to-end tests run against one server and are written not to care what
  earlier tests left in the book. They assert on the levels they created rather
  than on the whole book, apart from the consistency checks, which compare the
  browser against the backend and so are true whatever the starting state.

Cleanup code that runs after a test is cleanup code that does not run when the
test crashes, which is exactly when you need it.

## What is not simulated

No production data, anonymised or otherwise. The generator covers a wider space
than a replayed day of real trading, without the handling problem.

There is no market data replay from a real exchange. It would be useful for
performance realism and is not built; the load profile is synthetic and shaped
to the throughput target assumed in `qe/suites/perf/load.js`. See [NON-GOALS.md](NON-GOALS.md).
