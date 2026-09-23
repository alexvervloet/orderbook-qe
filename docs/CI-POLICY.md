# What runs when

The timings below were measured on this repository, on an Apple M-series
laptop, with `npm run ci:timings` unless marked otherwise. When they stop being
true the table is wrong and gets remeasured.

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

| Check | Tests | Cost | Tier |
| --- | --- | --- | --- |
| Lint | | 0.2s | PR |
| Typecheck | | 2.8s | PR |
| Unit: conformance on both engines, selection map, mutation registry | 146 | 0.5s | PR |
| Integration: settlement atomicity | 11 | 0.6s | PR |
| Property: differential, book invariants, ledger, corpus replay, 300 runs | 23 | 0.7s | PR |
| Contract: REST, WebSocket, JSON-RPC | 29 | 0.7s | PR |
| Consistency: offchain against onchain, 5 runs | 9 | 4.1s | PR |
| Solidity unit and fuzz, 256 fuzz runs | 40 | 0.1s | PR |
| Solidity invariants, 64 runs x 32 depth, two markets | 18 | 1.2s | PR |
| End-to-end | 6 | 2.5s, Playwright's own timing | PR |
| Container build, boot and a trade | | about 45s on GitHub | PR |
| Property, 20,000 runs | | 12.4s | nightly |
| Consistency, 40 runs | | 15.3s | nightly |
| Solidity invariants, 1,000 runs x 128 depth, two markets | | 117s | nightly |
| Chaos: reorg detection, network faults under Toxiproxy | 10 | about 3s, plus compose startup | nightly |
| Flake detection: vitest and forge, ten runs each | | minutes | nightly |
| Mutation testing | | tens of minutes | nightly |
| Load, stress, latency | | minutes | nightly |
| Soak | | 4 hours | weekly |

The checks themselves add up to about eleven seconds. On GitHub the jobs run in
parallel, so the verdict arrives when the slowest job finishes, which is the
container build at under a minute. That is comfortably inside budget, and the
room is deliberate: suites grow, and a tier with no headroom becomes a tier
someone disables.

## Every pull request, and every push to main

Everything deterministic and fast. Nothing here may need a network beyond
installing dependencies. The same workflow runs on pushes to main; there is no
separate merge tier yet.

- Lint and typecheck.
- The unit suite: both engines against the shared conformance suite.
- Property suites at 300 runs, and **every saved counterexample**, always.
  See [Counterexample corpus](#counterexample-corpus).
- Contract tests across all three protocols.
- Consistency at 5 runs, on the round-number market and the awkward one.
- Solidity unit, fuzz and invariant tests at the default profile, plus a gas
  report uploaded as an artifact.
- End-to-end in Chromium.
- Container build, boot, and one trade over REST.

**Quality gates.** The suites pass, the container boots and matches an order,
and no test was skipped outside a short allowlist. The skip check reads
vitest's own report of what ran, so a skip decided at runtime counts as much as
a `.skip` in the source. A suite quietly shrinking is the failure mode that takes
longest to notice.

The fuzz and invariant tests choose a new seed on every run, so a pull request
can occasionally find a real counterexample that the previous run missed. That
is a finding, not a flake, and it is treated as one.

## Nightly

The searching work. Nightly jobs may be slow and may find nothing for weeks.

- Property suites at 20,000 runs. A failing session is shrunk and written to
  the corpus, and the job opens an issue with the new entry, so a person reads
  it before it becomes a permanent test.
- Consistency at 40 runs.
- Solidity invariants at 1,000 runs and depth 128, on both markets.
- Mutation testing across the engine, the reference model, the ledger and the
  contract, uploaded as a report. **The score does not gate anything**; see
  [MUTATION.md](MUTATION.md).
- Chaos: the backend behind Toxiproxy for latency, dropped connections and a
  constrained link, and reorg detection against a local chain. The job requires
  Toxiproxy, so a missing proxy fails instead of skipping.
- Flake detection: ten runs of vitest and ten of forge, each forge run with a
  fresh fuzz seed.
- Load, stress and latency against the throughput target set in `load.js`, with
  results uploaded.

## Weekly

- Soak: four hours at a steady rate, failing if the last quarter's p99 latency
  is more than 25% above the first quarter's.

## Not yet

Named so their absence is a decision rather than a surprise: a dependency
audit, a gas report compared against the previous one, and pre-commit hooks.
The first two are cheap and belong in the weekly job; the third is a
convenience, since the pull request tier is fast enough to be the check.

## Counterexample corpus

Every failing case a property test finds is shrunk and can be written to
`qe/corpus/`, where it is replayed as an ordinary test on every pull request
from then on. The nightly job writes new ones automatically and files them as
issues; a person commits them once the cause is understood. Three reasons this
matters more than raising the run count:

1. A random search that found a bug once is not guaranteed to find it again. The
   corpus makes the regression deterministic.
2. Replaying the corpus costs milliseconds. Raising `numRuns` costs seconds on
   every pull request forever, for a lower chance of hitting the same case.
3. The corpus is readable. Each entry is a named sequence of orders, and it
   documents a real failure better than the changelog does.

## Test selection

The pull request tier runs in full because it takes under a minute. Selection is
built and in place for when it stops being under a minute, mapping changed files
to affected suites, and it is deliberately not used yet. Skipping tests to save
forty seconds trades a certainty for a risk at a bad exchange rate, and a
selection map that has never been wrong is a selection map nobody has checked.
CI prints what it would have selected on every run, so the map is compared with
reality before anything depends on it.

The map lives in `qe/select/` with the reasoning.

## Flakiness

A test that fails intermittently is deleted or fixed within one working day.
There is no quarantine that things sit in.

Quarantine sounds like a compromise and works as a graveyard: a test nobody
trusts still costs a run, still costs attention when it fails, and provides no
signal, so it is worse than no test. If a flaky test is worth keeping it is
worth a day; if it is not, it is worth deleting.

The nightly flake job runs both test runners repeatedly and fails on anything
not unanimous, so the decision is made from data rather than from whoever
noticed a red build. It has been pointed at a known flaky check on purpose, and
reports it. Its first version reported "no flaky tests" having read no results
at all; see [../LESSONS.md](../LESSONS.md).
