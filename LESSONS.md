# Lessons

Things that did not go the way the plan said they would. Written when they
happened, not reconstructed afterwards.

## A green property test that was barely testing anything

**Expected.** `fc.array(command, { minLength: 1, maxLength: 40 })` would produce
trading sessions averaging something like twenty commands, deep enough to build
a book and make orders cross.

**What happened.** The differential suite went green in 30 milliseconds for what
should have been 360 sessions. That was the tell. Instrumenting the generator
showed 300 sessions producing 1,828 commands between them: a mean of six. Six
commands is two or three resting orders and almost no crossing. Across all 300
sessions the engine executed 214 trades.

fast-check's array generator is biased toward short arrays by design, and the
bias is strong. `maxLength` is a ceiling, not a target.

**Fix.** `{ minLength: 15, maxLength, size: 'max' }`. Same 300 sessions now
produce 8,111 commands and 2,303 trades, a tenfold increase in the behaviour
actually being exercised.

**Next time.** A property test's pass is worth nothing until you have measured
what it generated. Before trusting one, count the interesting events: trades
executed, branches reached, outcome kinds seen. The generator is a piece of test
equipment and it needs calibrating like any other. A fast green run on a
property suite is a symptom, not a reassurance.

## Mutation testing found an equivalent mutant, and I called it a coverage gap

**Expected.** Changing `break` to `continue` in the FOK fillability scan would
over-count liquidity, let an unfillable FOK through, and get caught.

**What happened.** No suite caught it, at 400 runs or at 5,000. My first reading
was that the suites had a hole. They did not. `continue` skips the rest of the
loop body, including the line that adds to the total, and because the price
array is sorted best-first, every price after the first non-crossing one also
fails to cross. The mutant computes exactly the same number by a slower route.
It is an equivalent mutant, and no test can kill it, because there is nothing
observable to catch.

Deleting the price guard outright is the non-equivalent version of the same
idea. That one is invisible to all 104 hand-written unit tests and is caught
immediately by the differential suite.

**Next time.** A surviving mutant is a question, not a verdict. The first move
is to work out whether the mutant changes observable behaviour at all, because
a mutation score reported without that triage is inflated in one direction or
deflated in the other. Budget for the judgement, not just the tool. Record every
equivalent mutant with the argument for why it is equivalent, so the next person
does not re-derive it. Mine is in [docs/MUTATION.md](docs/MUTATION.md).

**Also worth keeping.** I stated the wrong conclusion before checking the loop
body. The 30 seconds it took to read `continue` properly would have saved the
claim.

## The hand-written suite missed what the differential caught

Not a failure, but the number is the reason the reference engine exists, so it
belongs here.

Six mutants were planted in the production engine by hand, all aimed at the
incremental bookkeeping that the fast data structures need and the naive
reference engine does not have.

| Mutant | 106 unit tests | Differential |
| --- | --- | --- |
| `moveToBack` skips the level aggregate update | caught | caught |
| `reduceDisplayed` leaves the level total stale | caught | caught |
| `remove()` forgets to decrement `orderCount` | **missed** | caught |
| Price array ordering comparison flipped | caught | caught |
| Iceberg refresh keeps its queue position | caught | caught |
| Price guard deleted from the fillability scan | **missed** | caught |

Two of six were invisible to every hand-written test and obvious to the
differential. Both were cached-aggregate bugs: a count and a total that the fast
engine maintains incrementally and the reference engine recomputes from scratch
every time. That is precisely the class of bug a second implementation exists to
find, and precisely the class a human writing assertions does not think to look
for, because nobody writes a test asserting that `orderCount` is still right.

The missing FOK case has since been added to the conformance suite, so the
second row is now caught by both. The first is still differential-only.

## An invariant suite that passed by swallowing the failure

**Expected.** Breaking the limit-price check in the contract's matching loop
would let a buy at 90 trade against an ask at 110, and the solvency or
crossed-book invariants would catch it immediately.

**What happened.** Every invariant passed. Foundry reported `reverts: 0` and 398
successful `placeOrder` calls.

The mutant does break the contract, badly. A taker escrows quote at its own
limit price, so executing above that limit underflows the escrow release and the
whole transaction reverts. Every affected call reverted, the handler's
`catch {}` absorbed each one as though it were an ordinary refusal, and the
invariants were then evaluated against a book on which nothing had happened.
They held, because nothing holds more reliably than a system that has stopped
working.

The `reverts: 0` line is the part worth remembering. It counts reverts that
escape the handler. A handler that catches everything reports zero reverts
whatever the contract does.

**Fix.** Two changes. The handler now distinguishes `catch Panic(uint256)` from
a named revert and counts panics in a ghost variable, and
`invariant_NoArithmeticPanics` asserts that count is zero. An arithmetic
underflow is never the contract refusing on purpose. Separately,
`afterInvariant` asserts the run placed at least one order, so a run that
exercised nothing fails loudly instead of passing quietly.

With both in place the mutant dies on the first run.

**Next time.** `try/catch` in an invariant handler is a decision about what
counts as acceptable behaviour, not error handling. Write down which reverts are
expected and assert that nothing else happened. And whenever an invariant suite
is green, check the call summary before believing it: the numbers that matter
are how many calls did real work, not how many ran.

**Second lesson, from fixing the first.** My first attempt asserted "the run
placed at least one order" as an invariant, and it failed immediately on the
correct contract. Foundry evaluates invariants after every call including the
first, when no order has been placed yet. Coverage of a run is a property of a
finished run, not of every state it passes through, so it belongs in
`afterInvariant`. An invariant that is false at the start of every run is not an
invariant.

## Solidity's overflow protection is not an error message

`placeLimitOrder(type(uint128).max, type(uint128).max)` reverted with an
arithmetic panic rather than the intended `InsufficientBalance`. `uint128 *
uint128` fits in a `uint256`, but multiplying by `quoteScale` does not, and the
overflow happened before the balance check.

Nothing was at risk; the transaction reverted, which is what should happen. But
a panic is indistinguishable from a contract bug at the call site, and an
integrator cannot tell "your order is too large to price" from "this exchange is
broken". The fix is an explicit guard and a named `NotionalOverflow` error.

**Next time.** Reverting for the right reason and reverting for a reason the
caller can act on are different requirements. Checked arithmetic satisfies the
first and not the second.

## Round numbers in the default market hid a whole class of bug

**Expected.** The Solidity suite was in good shape: 23 unit tests, three fuzz
tests, eight invariants over 2,048 calls, all green. The offchain/onchain
consistency suite would confirm the two implementations agreed.

**What happened.** They agreed on every market I had configured, and disagreed
within five runs on one I had not.

The default market uses `quoteScale` 10,000 against a 10,000 basis-point
denominator. Every fee therefore divides evenly, the ceiling never rounds
anything, and a buggy escrow formula and a correct one return identical numbers
for every input any of those tests could produce. The bug was unreachable, not
absent.

Setting `quoteScale` to 3 made the remainder real. fast-check shrank to four
orders and found an escrow underflow that permanently strands a trader's funds.
Details in [docs/FAILURE-MODES.md](docs/FAILURE-MODES.md).

**Next time.** Configuration is test input. Picking convenient round numbers for
a fixture is a decision to never exercise the arithmetic those numbers make
trivial, and it is invisible: the tests look thorough and the coverage looks
complete. Any system with fees, scaling or unit conversion needs at least one
fixture where nothing divides evenly, and it should be the one the property
tests run against.

## The consistency suite could not see a price

**Expected.** Comparing the offchain engine against the contract after identical
order sequences would catch any disagreement about matching.

**What happened.** A mutant that made the offchain engine execute at the taker's
limit price instead of the maker's resting price passed the entire consistency
suite.

The suite compared visible depth and base balances. Neither can see an execution
price. A fill of five lots moves five lots of base whether it printed at 101 or
at 105, and the depth left behind is identical either way. Price only appears in
the quote leg, which was not compared.

**Fix.** Compare quote holdings and collected fees as well as base. The mutant
then dies immediately, along with one that charged the maker rate to the taker.

**Next time.** Before trusting a comparison, ask which fields of the system it
can physically observe, and check that list against what can go wrong. "It
compares state after every command" sounds exhaustive and was missing half the
ledger. The discipline that caught it was mutation probing: I would not have
noticed by reading the assertions, because the assertions look comprehensive.

## viem's default polling made the chain tests look slow

**Expected.** Deploying three contracts and funding three traders against a
local Anvil node would take a moment.

**What happened.** It took 60.4 seconds, and the suite timed out.

Anvil mines instantly. viem polls for receipts every 4,000 milliseconds by
default, a sensible figure for a public network and pure dead time here. Fifteen
setup transactions at one tick each is sixty seconds of a test waiting for
nothing.

Setting `pollingInterval` to 20ms took the same work to 601 milliseconds, a
hundredfold difference from one line of configuration.

**Next time.** When a test harness is slow, measure before optimising the code
under test. The suspicious signal was that 60.4 seconds is not a plausible
duration for real work; it is a round number, and round numbers in timings mean
a timeout or a poll interval. Dividing the elapsed time by the number of
operations gave 4 seconds each, which named the cause immediately.

## The mutation runner hung for fifty minutes with a mutant in the working tree

**Expected.** 281 mutants at roughly 1.5 seconds each: about seven minutes,
fifteen at worst.

**What happened.** Fifty minutes, zero output, two Vitest workers pinned at 100%
of a core. `git status` showed `matching-engine.ts` and `ledger.ts` as modified,
which for this tool means a mutant was sitting in the source I was still editing
around.

The mutant was in the stop-trigger cascade:

```ts
for (;;) {
  const ready = stops.filter(...)
  if (ready.length === 0) break   // mutated to !== 0
  ...
}
```

With `!== 0`, an empty `ready` no longer breaks, the loop body does nothing, and
it spins forever. `execFileSync` has no default timeout, so the runner waited on
it indefinitely. Its `finally` block would have restored the source, but a
`finally` never runs while the `try` is still blocked.

**Three fixes, because there were three faults.**

1. A per-mutant timeout, `SIGKILL` at 60 seconds. A mutant that hangs counts as
   killed: the suite would never have gone green. It just must not take the
   harness with it.
2. A lock file. A second mutation run had started concurrently for the AI
   generation scoring, and two processes rewriting the same files in place
   corrupt each other's restore. Now the second one refuses to start and says
   why.
3. Signal handlers for `SIGINT` and `SIGTERM` that release the lock and warn to
   check `git status`. Interrupting a run must not leave a mutant behind.

Verified by reapplying the exact mutant: killed at 20 seconds under a 20-second
cap, source clean afterwards.

**Next time.** Any tool that modifies source in place and shells out needs the
timeout, the lock and the signal handler before its first real run, not after.
The dangerous property is not slowness, it is that the restore path runs only on
the happy path. I wrote the `finally` and thought the problem was handled; a
`finally` is not a guarantee when the body can block forever.

And the signal that something was wrong was arithmetic, not intuition: fifty
minutes against a seven-minute estimate is not "slower than expected", it is a
different failure. Estimating first is what made the hang visible.

## Most surviving mutants were equivalent, and finding that out is the work

**Expected.** A 93% kill rate with 20 survivors meant roughly 20 gaps in the
tests.

**What happened.** Thirteen of the twenty could not be killed by any test.

They fell into three groups, and none of them is obvious from the diff:

*The mutated branch returns the same value.* `(a < b ? a : b)` becoming
`(a <= b ? a : b)` differs only when `a` equals `b`, and then both branches
return the same thing.

*An earlier return makes the boundary unreachable.* `position > 0n` becoming
`>= 0n` looks like a real off-by-one until you notice that a zero position was
rejected three lines above, so the comparison never sees zero.

*Equivalence by caller rather than by the function.* `cmpAsc` is only reached
from a price comparator that guards with `if (pa !== pb)`, so the equal case
never arrives. This one is the least comfortable of the three: the function is
not equivalent, its use is, and if anything else ever calls `cmpAsc` the
registry entry becomes wrong. It is recorded with that caveat attached.

Of the seven genuine survivors, four were real gaps worth closing: an overdraft
guard that nothing tested at the exact-balance boundary, the guard's choice of
*which* asset to report, and a stop order with a null trigger price that no
builder could produce. One was not a gap at all: `isEmpty` on the book side was
dead code, defined and never called. The right response to a survivor on unused
code is to delete the code.

**Next time.** Budget the triage, not just the run. The run took twenty minutes
unattended; classifying twenty survivors took longer and was the part that
produced the value. A mutation score quoted without that pass is not a
measurement, it is a starting point, and quoting it as a result overstates the
suite in one direction and the gaps in the other.

Write the argument down for each equivalent mutant, in the code. I will not
remember why `cmpAsc` was safe in six months, and neither will anyone else, and
the alternative is re-deriving it every nightly run.

## A skip decided before the flag was set

**Expected.** The network fault tests would detect Toxiproxy in `beforeAll`, set
`available = true`, and run.

**What happened.** They skipped, against a Toxiproxy that was up and healthy,
and the suite reported green.

Vitest registers `describe` blocks during collection, which happens before any
hook runs. So `describe.skip` was decided while `available` was still its
initial `false`, and no value assigned in `beforeAll` could ever change that.
The suite would have skipped forever.

**Fix.** A top-level `await` at module load, so the check happens during
collection, when the decision is made.

**Next time.** Anything that decides whether a test runs has to be evaluated at
collection time, not in a hook. And the general shape of this is the third
instance of the same failure in this repository: a green suite that was not
running. A property suite generating six-command sessions, an invariant handler
swallowing every revert, and now a conditional skip that could never be false.

None of the three announced itself. All three were found by asking a number
whether it made sense: 30 milliseconds for 360 sessions, `reverts: 0` on a
contract that should have been reverting constantly, and five skipped tests
against a service that was demonstrably up. The habit that catches this class is
not writing better tests, it is reading the run output as data rather than
scanning it for red.

## Twenty orphaned test workers, eleven cores, three hours

**Found by** the person whose laptop it was, asking why Activity Monitor was
full of node processes. Not by me, and not by anything in this repository.

**What happened.** The mutation harness runs the suite once per mutant through
`execFileSync`. Some mutants turn a loop into an infinite one. When I killed a
hung mutation run with `pkill`, it killed the harness and orphaned the test
runner's worker processes, which were still spinning inside the mutant's loop
with nothing pointing at them.

Twenty accumulated, at 1119% CPU between them, alongside ten Anvil nodes leaked
the same way. Load average reached 130.

**It also caused a bug hunt that had nothing to do with the bug.** The
offchain/onchain suites started failing with the contract reporting empty books.
I was three steps into blaming fixture setup when the real cause was that the
machine had no CPU left to start a chain in.

**Three separate faults.**

1. The per-mutant timeout I added after the first hang kills the child the
   harness is waiting on. It does nothing when the harness itself is killed from
   outside, which is precisely how the first hang ended.
2. `startChain` killed its Anvil in `stop()`, called from `afterAll`. A file
   that throws in `beforeAll`, or a worker killed by a timeout, never reaches
   `afterAll`.
3. The onchain fixture swallowed setup failures. Unfunded accounts produced
   "the contract disagrees with the engine" instead of "setup failed".

**Fixes.** The mutation runner reaps orphaned workers on timeout, on signal and
on exit. `startChain` tracks every chain it starts and kills them all from
`exit`, `SIGINT`, `SIGTERM` and `uncaughtException`. The onchain fixture asserts
every funding transaction succeeded and then reads a balance back to prove it.

Verified by simulating the crash: a script that starts a chain and throws before
`stop()` now leaves nothing behind.

**Next time.** Cleanup that lives only in the happy path is not cleanup. That is
the same lesson as the `finally` that could not run because its `try` was
blocked, and I did not generalise it the first time: I fixed the specific case
and left the same shape in two other places.

Any process this harness spawns needs an owner that survives the harness dying,
and "I will remember to call stop()" is not one. The check is not "does cleanup
run when the test passes", it is "does cleanup run when the process is killed
mid-test", and the way to find out is to kill it and look.

## The mutation runner restored the source and left the bytecode

**Expected.** Restoring the mutated file in a `finally` block returns the
repository to a clean state.

**What happened.** For TypeScript it does. For Solidity it does not, and I did
not notice the difference.

`forge test` compiles before it runs, so each Solidity mutant leaves its
bytecode in `out/`. The runner restored `OrderBookExchange.sol` and stopped
there, so the last mutant's bytecode stayed on disk. Everything that deploys
from `out/`, which is every offchain/onchain and chaos test, was then deploying
a deliberately broken contract.

**The symptom pointed somewhere else entirely.** Thirteen tests failed with the
contract reporting empty books and unmoved balances. `git status` was clean. I
spent an hour on the fixture: I added assertions that every funding transaction
succeeded, added a balance read-back to prove the fixture worked, chased a
suspected port race under parallel workers, and blamed machine load. All of that
was reasonable and none of it was the problem. `forge build --force` fixed it in
four seconds.

**Fix.** The runner recompiles after restoring a Solidity target, and warns
loudly if it cannot.

**Next time.** "Restore the file" is only equivalent to "restore the state" for
a language with no build step. Anything that mutates a compiled source has to
restore the artifact too, and a clean `git status` actively argues against
looking there, which makes it worse than no signal at all.

The fixture assertions I added while chasing this are worth keeping regardless:
the fixture used to swallow failed setup transactions, and would have reported
"the contract disagrees with the engine" for an unfunded account. That was a
real fault, just not this one.

## Two engines that agreed on a crossed book

**Expected.** The differential test compares every observable after every
command, so a matching bug in either engine shows up as a divergence.

**What happened.** An audit found a book with a bid at 105 resting over an ask
at 104. Both engines ran the stop cascade before resting the taker's remainder,
so a triggered stop_limit rested on the far side and the remainder then rested
through it. Both engines also let each fired stop start a cascade of its own,
which ran a stop triggered later ahead of one triggered earlier. Thousands of
differential runs passed, because the two engines were wrong in the same way.
The conformance test "leaves the book uncrossed at rest" only submitted orders
that did not cross, so it could not fail either.

A new property that checks the book on each engine alone, with no oracle,
failed on the first run in under a hundred milliseconds.

**Fix.** Each order is matched and rested before any stop it triggered runs,
and stops fire in rounds. The outcome returned describes the order as it
stands on return, since a stop can fill the order that triggered it.

**Next time.** A differential test checks that two implementations agree. It
says nothing about whether they are right, and two implementations written by
the same person from the same spec are exactly the ones likely to share a
misreading. Every invariant the spec states in one sentence, like "the book is
never crossed at rest", deserves a property of its own that no oracle can
talk it out of.
