# What runs when

Every number here was measured on this repository, on an Apple M-series laptop,
and is reproducible with `npm run ci:timings`. They are not estimates, and when
they stop being true the table is wrong and gets remeasured.

## The rule

A pull request check exists to stop a bad change reaching main. A nightly job
exists to find what the pull request checks are not built to see. Putting a
nightly job on a pull request does not make the pull request safer; it makes the
feedback slower, which makes people batch changes, which makes every failure
harder to attribute.

The budget for pull request feedback is **five minutes from push to verdict**.
Past that, people stop waiting and start context-switching, and the check has
lost most of its value even when it works.

## Measured cost

| Check | Cost | Tier |
| --- | --- | --- |
| Lint | 0.6s | pre-commit, PR |
| Typecheck | 2.6s | pre-commit, PR |
| Unit, 116 tests | 0.5s | pre-commit, PR |
| Integration, settlement atomicity | 0.2s | PR |
| Counterexample corpus | 0.2s | PR |
| Solidity unit and fuzz, 26 tests | 0.1s | PR |
| Property, differential and ledger, 300 runs | 0.7s | PR |
| Contract, REST, WebSocket, JSON-RPC, 28 tests | 0.7s | PR |
| Solidity invariants, 64 runs x 32 depth | 0.9s | PR |
| Offchain/onchain consistency, 5 runs | 3.6s | PR |
| End-to-end, 6 browser cases | 2.4s | PR |
| Container build and smoke | ~40s | PR |
| **Pull request total** | **~55s** | |
| Property, 5,000 runs | 3.2s | nightly |
| Consistency, 40 runs | 15.1s | nightly |
| Solidity invariants, 1,000 runs x 128 depth | 53.5s | nightly |
| Mutation testing | minutes | nightly |
| Load, stress and latency | minutes | nightly |
| Chaos: reorg, network faults, recovery | ~4s | nightly |
| Soak | hours | weekly |
| Soak | hours | weekly |

The pull request tier comes to roughly 55 seconds of work, most of it the
container build. That is comfortably inside budget, and the room is deliberate:
suites grow, and a tier with no headroom becomes a tier someone disables.

## Every pull request

Everything deterministic and fast. Nothing here may be flaky, and nothing here
may need a network.

- Lint and typecheck.
- The full unit suite, both engines against the shared conformance suite.
- Solidity unit and fuzz tests at 256 fuzz runs.
- Property suites at 300 runs, plus **every saved counterexample**, always.
  A counterexample found once runs on every pull request forever, at effectively
  no cost. See [Counterexample corpus](#counterexample-corpus).
- Contract tests across all three protocols.
- Solidity invariants at the shallow profile.
- Consistency at 5 runs, enough to catch a gross divergence.
- Container build, boot and a trade over REST.

**Quality gates.** The suite passes, the container boots and serves a trade, and
no test was skipped. A skipped test fails the build; a suite quietly shrinking
is the failure mode that takes longest to notice.

## Merge to main

The pull request tier, plus the container published, plus the property suites at
1,000 runs. Main is what nightly and any deployment build on, so it gets a
little more than a branch does.

## Nightly

The searching work. Nightly jobs may be slow and may find nothing for weeks.

- Property suites at 5,000 runs, with any new counterexample committed to the
  corpus automatically and opened as an issue.
- Consistency at 40 runs, across both the round-number and awkward-scale
  markets. The awkward market is the one that found the escrow bug; see
  [FAILURE-MODES.md](FAILURE-MODES.md).
- Solidity invariants at 1,000 runs and depth 128.
- Mutation testing across the engine, the ledger and the contract, with a report
  and a diff against last night's surviving set. **The score does not gate
  anything**; see [NON-GOALS.md](NON-GOALS.md).
- Load, stress and latency against the committed testnet target.
- Chaos: dropped connections, added latency, partitions, restarts mid-trade.
- Flake detection: the pull request suite run ten times, with any test that is
  not unanimous reported.

## Weekly

- Soak, hours of sustained load, watching for drift rather than failure.
- Dependency audit and a gas report diff.

## Counterexample corpus

Every failing case a property test finds is shrunk, written to
`qe/corpus/`, and replayed as an ordinary test on every pull request from then
on. Three reasons this matters more than raising the run count:

1. A random search that found a bug once is not guaranteed to find it again. The
   corpus makes the regression deterministic.
2. Replaying the corpus costs microseconds. Raising `numRuns` costs seconds on
   every pull request forever, for a lower chance of hitting the same case.
3. The corpus is readable. Each entry is a named sequence of orders, and it
   documents a real failure better than the changelog does.

## Test selection

The pull request tier runs in full because it takes under a minute. Selection is
built and in place for when it stops being under a minute, mapping changed files
to affected suites, and it is deliberately not used yet. Skipping tests to save
forty seconds trades a certainty for a risk at a bad exchange rate, and a
selection map that has never been wrong is a selection map nobody has checked.

The map lives in `qe/select/` with the reasoning.

## Flakiness

A test that fails intermittently is deleted or fixed within one working day.
There is no quarantine that things sit in.

Quarantine sounds like a compromise and works as a graveyard: a test nobody
trusts still costs a run, still costs attention when it fails, and provides no
signal, so it is worse than no test. If a flaky test is worth keeping it is
worth a day; if it is not, it is worth deleting.

The nightly flake job runs the pull request suite ten times and reports anything
that is not unanimous, so the decision is made from data rather than from
whoever noticed a red build.
