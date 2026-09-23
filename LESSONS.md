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
