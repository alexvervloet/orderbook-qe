# Walkthrough

The intended path through this repository, from a clean checkout to the slowest
suite, with the code worth reading at each step and the things that will
surprise you if nobody warns you.

It goes in the order the system is built: run the exchange, read the rules it
follows, then climb the test layers from the engine up to the chain, the
network and the tests that measure the tests. Allow an hour for steps 1 to 9.
Steps 10 onward need Docker, k6 or an API key, and can be done in any order.

## 0. Before you start

You need:

- **Node 22.6 or later.** Every script runs TypeScript directly with
  `--experimental-strip-types`, which older Node does not have. CI uses Node 24.
- **Foundry v1.8.3**, installed with `foundryup`. The chain suites start Anvil
  from `~/.foundry/bin/anvil`, not from your `PATH`
  ([chain.ts:126](qe/framework/chain.ts#L126)). If Foundry lives somewhere else,
  set `ANVIL_BIN`, or those suites fail to start a chain.
- **Docker** for the chaos suite, and **k6** for the performance suites. Nothing
  else needs either.

Then:

```bash
git submodule update --init          # forge-std, which the Solidity tests import
npm install
(cd sut/contracts && forge build)
```

Build the contract before running the TypeScript tests. The consistency and
reorg suites deploy the bytecode in `sut/contracts/out/`, and without it they
fail. A stale `out/` is worse than a missing one: it deploys whatever was built
last, and the failures look like a fixture problem. That cost an hour once; see
[LESSONS.md](LESSONS.md).

## 1. Run the exchange

```bash
npm start
```

It prints `seeded 5 accounts` and listens on port 8080. Set `PORT` to move it,
and `SEED_ACCOUNTS=0` to start empty. The five accounts are in
[seed.ts](sut/backend/seed.ts): `maker-1`, `maker-2`, `taker-1` and `taker-2`
are funded, and `broke-1` has nothing, on purpose
([seed.ts:27](sut/backend/seed.ts#L27)).

Open `http://localhost:8080` for the trading UI, or drive it by hand:

```bash
curl -s -X POST localhost:8080/orders -H 'content-type: application/json' \
  -d '{"accountId":"maker-1","side":"sell","price":"100","quantity":"3"}'
# {"orderId":"ord-1","status":"resting",...,"filled":"0","remaining":"3",...}

curl -s -X POST localhost:8080/orders -H 'content-type: application/json' \
  -d '{"accountId":"taker-1","side":"buy","price":"101","quantity":"2"}'
# {"orderId":"ord-2","status":"filled",...,"trades":[{...,"price":"100","quantity":"2"}],...}

curl -s localhost:8080/book
# {"sequence":3,"bids":[],"asks":[{"price":"100","quantity":"1","orderCount":1}]}
```

The buy at 101 traded at 100, the maker's price. That is section 3 of the spec.
Three things to try next, each of which shows a decision:

- **An unfunded order.** Send the same buy from `broke-1`. It comes back
  `"status":"rejected","reason":"insufficient_funds"` with HTTP 422, and the
  book is untouched. This check is
  [exchange.ts:82](sut/backend/exchange.ts#L82), and it exists because the
  exchange once matched first and settled second, which let an account with no
  money destroy a maker's order.
- **A number instead of a string.** Send `"quantity":1` rather than `"1"`. It
  is refused with HTTP 400. Every integer on the wire is a decimal string
  ([wire.ts:15](sut/backend/wire.ts#L15)), because `JSON.parse` turns
  `9007199254740993` into `...992` and on an exchange that is a fill nobody
  asked for.
- **The same thing over JSON-RPC.** `POST /rpc` with
  `{"jsonrpc":"2.0","id":1,"method":"exchange_getBalance","params":{"accountId":"taker-1"}}`.
  After the trade above, `taker-1` holds 2,000,000 more base (two lots at a
  `baseScale` of 1,000,000) and 2,001,400 less quote: 2,000,000 notional plus
  a 1,400 fee at the 7 basis-point taker rate. The methods are
  `exchange_getBook`, `exchange_getBalance`, `exchange_submitOrder` and
  `exchange_cancelOrder`.

`GET /ws` is the market data feed. It opens with a snapshot and then sends one
delta per book change, each with the next sequence number:

```
{"type":"snapshot","sequence":3,"bids":[],"asks":[{"price":"100","quantity":"1","orderCount":1}]}
{"type":"delta","sequence":4,"changes":[{"side":"buy","price":"95","quantity":"4","orderCount":1}]}
```

The UI builds its book from exactly that, rather than refetching, because
applying deltas is where real clients drift out of sync and that is what the
end-to-end suite checks.

## 2. Read the rules

Two short documents define everything the tests assert. Read them before any
code.

- [spec/SEMANTICS.md](spec/SEMANTICS.md): matching. Section 3 says the book is
  never crossed at rest. Section 9 says how stop orders fire, in rounds, after
  the order that triggered them is finished. That rule is recent, and the
  reason is step 5.
- [spec/LEDGER.md](spec/LEDGER.md): settlement, fees that always round up, and
  the onchain escrow rule.

Everything is an integer. Prices are ticks, quantities are lots, and the market
converts them with `quoteScale` and `baseScale`. There is no decimal anywhere.
[docs/PRECISION.md](docs/PRECISION.md) explains why.

## 3. The two engines

There are two matching engines, and the whole design depends on them being
separate.

- [qe/model/reference-engine.ts](qe/model/reference-engine.ts) is the oracle.
  The book is a flat array, re-sorted on every access. It is slow on purpose,
  so it can be checked against the spec line by line. The header says to revert
  any change that makes it faster.
- [sut/backend/engine/matching-engine.ts](sut/backend/engine/matching-engine.ts)
  is the real one, with price-level maps and linked lists in
  [book-side.ts](sut/backend/engine/book-side.ts).

In both, read `#execute` first
([reference:156](qe/model/reference-engine.ts#L156),
[production:167](sut/backend/engine/matching-engine.ts#L167)). It matches one
order and rests its remainder, and never runs the stop cascade. The cascade
([reference:339](qe/model/reference-engine.ts#L339)) runs afterwards, in rounds.
Both engines used to run the cascade in the middle of the order, and step 5 is
how that was found.

## 4. The fast suites

```bash
npm test
```

Expect `223 passed | 5 skipped (228)` in a few seconds. The five skips are the
network chaos tests, which need Toxiproxy (step 10). One test in that file
always runs and prints the command that would make the rest run, so the skip
is visible.

`npm test` covers unit, property, contract, integration, consistency and chaos.
Each has its own script (`npm run test:unit` and so on) if you want one at a
time.

The unit suite is one conformance suite,
[conformance.ts](qe/suites/unit/conformance.ts), run against both engines. Each
block names the spec section it enforces.

## 5. The property layer, where the bugs were

This is the part of the repository that has found the most.

[sessions.ts](qe/framework/sessions.ts) replays a generated trading session two
ways:

- `replayDifferential` ([sessions.ts:34](qe/framework/sessions.ts#L34)) drives
  both engines and compares everything a client could see after every command.
- `replayInvariants` checks one engine alone against rules that need no
  oracle: the book is uncrossed and no stop is left waiting that should have
  fired ([sessions.ts:69](qe/framework/sessions.ts#L69)), and every resting
  order's fills plus what is left equal what it was accepted for
  ([sessions.ts:99](qe/framework/sessions.ts#L99)).

The second exists because the first has a blind spot. Both engines once left
the same crossed book, and the differential suite passed thousands of runs,
because two engines that agree can be wrong together. The invariant property
failed on its first run.

You can watch one fire. Break the production engine so that a partial fill
loses a lot:

```bash
sed -i.bak 's/      maker.remaining -= quantity$/      maker.remaining -= quantity + (quantity > 1n \&\& maker.remaining > quantity ? 1n : 0n)/' \
  sut/backend/engine/matching-engine.ts
npx vitest run qe/suites/property/book-invariants.test.ts
mv sut/backend/engine/matching-engine.ts.bak sut/backend/engine/matching-engine.ts
```

The production engine fails with a message like
`order o22 is not accounted for: 2 filled + 1 resting != 4 accepted`, followed
by the session that caused it. The order and command numbers change from run
to run, because the generator is random.

Failing sessions are shrunk by fast-check and can be saved.
`assertSessions` ([corpus.ts:127](qe/framework/corpus.ts#L127)) writes the
shrunk session to [qe/corpus/counterexamples.json](qe/corpus/counterexamples.json)
when `SAVE_COUNTEREXAMPLES=1`, and the corpus replays on every run. The crossed
book is in there. Local runs leave the file alone unless you set that variable.

Property runs default to 300. `PROPERTY_RUNS=20000 npm run test:property` is
what the nightly job does, and takes about twelve seconds.

## 6. Money offchain

- [ledger.ts:104](sut/backend/ledger.ts#L104), `settle`, moves one trade's
  base, quote and fees. It checks every leg before moving anything, and throws
  rather than let a balance go negative.
- [exchange.ts:82](sut/backend/exchange.ts#L82) refuses an order before
  matching if its worst case is unaffordable. Stops are checked too, at
  submission; they used to skip the check entirely.
- [settlement-atomicity.test.ts:60](qe/suites/integration/settlement-atomicity.test.ts#L60)
  is the test for the bug that motivated both.

The offchain side does not reserve funds once an order is accepted. A maker who
spends their balance elsewhere can still fail to settle later, and the exchange
then stops loudly with `SettlementInconsistencyError`. That is deliberate and
written up in [docs/NON-GOALS.md](docs/NON-GOALS.md).

## 7. The contract

```bash
cd sut/contracts && forge test
```

Expect 45 tests passing across four suites. The contract is
[OrderBookExchange.sol](sut/contracts/src/OrderBookExchange.sol). It only does
good-till-cancelled limit orders; stops, icebergs and self-trade prevention
live offchain. Read, in order:

- `placeLimitOrder` ([line 156](sut/contracts/src/OrderBookExchange.sol#L156)).
  Funds are escrowed at placement, at the order's own limit, plus a worst-case
  fee per lot from `_feePerLot`
  ([line 427](sut/contracts/src/OrderBookExchange.sol#L427)).
- `_match` ([line 228](sut/contracts/src/OrderBookExchange.sol#L228)). It stops
  after 64 fills to bound gas, and if crossable liquidity is still there it
  refuses the whole order with `MatchStepLimitReached`
  ([line 266](sut/contracts/src/OrderBookExchange.sol#L266)) rather than rest
  through it.
- `_settle` ([line 276](sut/contracts/src/OrderBookExchange.sol#L276)). It
  releases escrow by exactly the per-lot rule it was locked with. The worst bug
  in this repository lived here, twice: see
  [docs/FAILURE-MODES.md](docs/FAILURE-MODES.md), entries 1 and 2.

The invariant suite drives random calls through
[Handler.t.sol](sut/contracts/test/Handler.t.sol), which separates an
arithmetic panic from a deliberate refusal
([Handler.t.sol:66](sut/contracts/test/Handler.t.sol#L66)). An earlier handler
caught everything and passed with a broken contract.
`invariant_LockedFundsMatchOpenOrders`
([Invariant.t.sol:142](sut/contracts/test/Invariant.t.sol#L142)) requires every
locked unit to belong to an open order. The whole suite runs twice, once on a
market whose fees divide evenly and once on one where they do not
([Invariant.t.sol:250](sut/contracts/test/Invariant.t.sol#L250)), because the
escrow bugs were invisible on the first.

**A surprise worth knowing.** When an invariant fails, Foundry saves the failing
sequence under `sut/contracts/cache/invariant/` and replays it first on every
later run. One flaky failure then looks like a permanent one. If an invariant
failure will not go away, look for "Replayed invariant failure from persisted
file" in the output and delete that directory.

## 8. The seam between offchain and onchain

```bash
npm run test:consistency
```

[offchain-onchain.test.ts](qe/suites/consistency/offchain-onchain.test.ts)
starts its own Anvil on a free port, deploys the contract, and drives the same
orders through the TypeScript engine and ledger and through the contract, then
compares books and balances. It only uses limit orders, because that is all the
contract implements. The second half
([line 206](qe/suites/consistency/offchain-onchain.test.ts#L206)) repeats it on a
market with a `quoteScale` of 3. That market is where the first escrow bug
turned up.

`CONSISTENCY_RUNS=40` is the nightly depth, about fifteen seconds.

## 9. The protocols and the browser

- [websocket.test.ts:90](qe/suites/contract/websocket.test.ts#L90) applies every
  delta to the opening snapshot and requires the result to equal a freshly
  fetched book. That one assertion covers a family of feed bugs.
- [rest.test.ts:76](qe/suites/contract/rest.test.ts#L76) round-trips
  `9007199254740993` and checks nothing lost the last digit.

```bash
npx playwright install chromium
npm run test:e2e
```

Six browser cases, about two and a half seconds. Playwright starts its own
server on port 8099. The cases that matter compare what the browser shows with
what the backend holds, after a session and after a reload.

## 10. Chaos

```bash
docker compose --profile chaos up -d --build --wait
REQUIRE_TOXIPROXY=1 npm run test:chaos
docker compose --profile chaos down
```

Expect 10 passing. The compose profile runs the backend behind Toxiproxy, and
the network tests add latency, cut the connection and throttle it, then check
the exchange fails in ways a client can act on. Without the profile these five
tests skip. With `REQUIRE_TOXIPROXY=1` a missing proxy is a failure instead
([network.test.ts:82](qe/suites/chaos/network.test.ts#L82)), which is how the
nightly job runs them.

The reorg test ([reorg.test.ts:85](qe/suites/chaos/reorg.test.ts#L85)) settles a
trade on both sides, reverts the chain to before the fill, and requires the
reconciler to report the divergence. Detection is tested; recovery is not
built.

The first compose build pulls a 500 MB Foundry image for the Anvil service, so
give it time.

## 11. Performance

Start the exchange (step 1, or `docker compose up -d --wait backend`), then:

```bash
mkdir -p qe/suites/perf/results
k6 run qe/suites/perf/latency.js
k6 run qe/suites/perf/load.js
k6 run qe/suites/perf/stress.js
DURATION=10m k6 run qe/suites/perf/soak.js
```

Each script writes its summary into `qe/suites/perf/results/`, and **k6 does not
create that directory**. It is gitignored, so on a fresh checkout it is missing,
and k6 logs "could not save some summary information", loses the summary, and
still exits 0. Point the scripts at another server with `BASE_URL`. Load,
latency and soak take `DURATION`; stress runs fixed stages up to 3,000 orders a
second and takes about two minutes.

A 422 counts as a success here: it is the exchange refusing an order for a
stated reason. Only server errors and dropped connections count as failed
requests.

The soak's real check is drift: the last quarter's p99 against the first's. k6
thresholds cannot compare two metrics, so the script writes a verdict to
`qe/suites/perf/results/soak-verdict.json`
([soak.js:110](qe/suites/perf/soak.js#L110)) and the weekly workflow fails on
it.

## 12. Tests that measure the tests

**Mutation testing.**

```bash
npm run mutate                        # everything, tens of minutes
npm run mutate -- --target ledger     # one target, seconds
```

It rewrites the source files in place, one mutant at a time. **Do not edit
code, or run tests, while it runs**: you would be testing a mutant. A lock file
stops two runs overlapping. Ctrl-C stops the run between mutants, restores the
source, rebuilds the contract if it was the target, and writes no report.

Before scoring a target it runs the suite on unmutated code
([run.ts:233](qe/mutation/run.ts#L233)) and refuses to go on if that fails,
because a red suite "kills" every mutant. The current result is 237 of 238 with
19 argued equivalents, and [docs/MUTATION.md](docs/MUTATION.md) explains why it
used to say 258 of 258. Equivalent mutants are excused one operator at a time
([equivalents.ts:187](qe/mutation/equivalents.ts#L187)), and a unit test fails
if an entry names a mutant that no longer exists.

**Flake detection.**

```bash
npm run flake:detect -- --runs 3
```

Runs vitest and forge repeatedly and fails on anything that is not unanimous.
Each forge run gets its own fuzz seed
([flake.ts:98](qe/tools/flake.ts#L98)); without one, repeated forge runs here
reused a seed and could not find a flaky check that failed one plain run in
four.

**The skip gate.**

```bash
npm run check:no-skips
```

Runs the whole vitest suite again, reads what actually ran, and fails on any
skipped test outside the allowlist
([no-skips.ts:34](qe/tools/no-skips.ts#L34)). It is a full second test run, so it
takes as long as `npm test`.

**Timings.** `npm run ci:timings` measures each check and prints the pull
request total against the five-minute budget. The container build is not
included.

## 13. AI triage and generation

These cost money and need `ANTHROPIC_API_KEY`.

```bash
npm run ai:triage                                  # Haiku 4.5, cents
npm run ai:triage -- --model claude-sonnet-5
AI_MAX_SPEND_USD=1 npm run ai:generate -- --target ledger
```

Triage classifies ten real failures from building this repository and scores
the model against labels assigned by hand. Generation writes a test suite from
the spec and scores it by mutation kill rate against the hand-written one.

Every call is checked against a spend limit before it is sent
([client.ts:76](qe/ai/client.ts#L76)). The default is $0.25, and one generation
call can cost more than that on its own, so `ai:generate` refuses to start
until you raise `AI_MAX_SPEND_USD`. That is deliberate. Results go to
`qe/ai/results/`, and [docs/AI-IN-QE.md](docs/AI-IN-QE.md) has the numbers,
including a correction: the corpus once held two invented failures.

## 14. CI

- [pr.yml](.github/workflows/pr.yml) runs on every pull request and every push
  to main: lint and typecheck, the TypeScript suites, the skip gate, forge with a
  gas report, the browser suite, and a container that has to boot and match an
  order. Under a minute of wall clock.
- [nightly.yml](.github/workflows/nightly.yml) runs the deep property and
  consistency runs, the deep invariants, mutation testing, flake detection,
  chaos under Toxiproxy, and load. A property failure is saved and opened as an
  issue.
- [weekly.yml](.github/workflows/weekly.yml) runs the four-hour soak. Run it by
  hand with a shorter `duration` input to try it.

Why each check is where it is: [docs/CI-POLICY.md](docs/CI-POLICY.md).

## Things that will surprise you

Collected from the steps above, because these are the ones that cost time.

- The chain suites look for Anvil in `~/.foundry/bin`, not on your `PATH`. Set
  `ANVIL_BIN` if yours is elsewhere.
- Stale bytecode in `sut/contracts/out/` gets deployed without complaint. Run
  `forge build` after changing the contract, before any TypeScript suite.
- Foundry replays a persisted invariant failure on every run until you delete
  `sut/contracts/cache/invariant/`.
- The fuzz and invariant tests pick a new seed every run, so a forge run can
  occasionally find something the last one did not. That is a finding, not
  flakiness.
- `npm run mutate` edits your source files while it runs.
- `npm run check:no-skips` runs the whole suite a second time.
- `SAVE_COUNTEREXAMPLES=1` writes to a committed file.
- k6 loses its summary if `qe/suites/perf/results/` does not exist.
- `ai:generate` will not run at the default spend limit.
- The offchain exchange checks an order's funds when it arrives and never
  reserves them, so a later settlement can still fail. That is a documented
  gap, not a bug.
- The onchain contract refuses an order that would need more than 64 fills to
  finish crossing. Split it.

For what went wrong while building all this, and what each failure taught, read
[LESSONS.md](LESSONS.md) next.
