# Failure modes

Every defect this harness has found, what caused it, and the test that now
catches it.

Each entry says whether the bug was **planted** to probe a suite or **real**,
meaning it was written by accident and found afterwards. The real ones are the
only evidence that any of this works, so they are marked plainly and not
inflated.

## Real

### 1. Partial fills exhaust the fee escrow and strand funds

**Severity.** A trader's funds become permanently locked. The order cannot fill
and cannot be cancelled.

**Where.** `sut/contracts/src/OrderBookExchange.sol`, escrow accounting.

**What happened.** Fees were escrowed once for the whole order, rounded up on
the total, and released one fill at a time, rounded up on each fill. Those two
numbers are not the same. `ceil(a + b)` is less than or equal to
`ceil(a) + ceil(b)`, and whenever it is strictly less, releasing every fill
tries to release more escrow than was ever taken. The subtraction underflows,
the transaction reverts, and it keeps reverting. Cancelling reverts for the same
reason, so the escrow can never be recovered.

**Why nothing caught it sooner.** The default market uses a `quoteScale` of
10,000 against a 10,000 basis-point denominator, so every fee divides evenly and
the ceiling never does anything. The 23 Solidity tests of the time, three of
them fuzz tests, and eight invariants all passed, because on that market the buggy formula and the
correct one return the same number for every input.

**How it was found.** The offchain/onchain consistency suite, on a deliberately
awkward market with `quoteScale` of 3. fast-check shrank it to four orders:

```
sell 1 @ 98      rests
buy  2 @ 99      fills 1 against the ask, 1 rests
sell 1 @ 98      crosses the resting bid
sell 1 @ 98      rests
```

The third order reverted onchain and succeeded offchain, and the books diverged.

**Fixed by.** `_feePerLot`, which locks a ceiling per lot instead of one on the
total. Locking and releasing then perform the same arithmetic in a different
order, which always balances, provided the release uses the same rule. The
first version of this fix did not; see entry 2.

**Now caught by.** `sut/contracts/test/FeeRounding.t.sol`, the awkward-market
consistency suite, and the `LockedFundsMatchOpenOrders` invariant.

**The transferable part.** A market's parameters are test inputs. Choosing round
numbers for the default market made an entire class of arithmetic bug
unreachable by every test that used it. Any suite for a system with fees needs
at least one configuration where the fees do not divide evenly.

### 2. The escrow fix left dust locked forever

**Severity.** Small amounts, one or two units per fill, locked permanently with
no order left to cancel.

**What happened.** Entry 1's fix locked `quantity * ceil(fee per lot)` but kept
releasing `ceil(fee on the whole fill)`. For a fill of two lots or more the
release is smaller, and the difference stayed in `lockedQuote` after the order
was gone.

**Why nothing caught it.** Every fee-rounding test filled one lot at a time,
where the two formulas agree. The invariant suite ran only on the round-number
market. Its solvency check is "owes no more than it holds", which funds locked
against nothing satisfy.

**How it was found.** An audit, by arithmetic.

**Fixed by.** Releasing escrow per lot, at the price each order locked at.

**Now caught by.** Multi-lot tests and `testFuzz_NothingLockedOnceNothingRests`
in `FeeRounding.t.sol`, and a new invariant, `LockedFundsMatchOpenOrders`, that
runs on both the round-number market and one with a `quoteScale` of 3. Against
the unfixed release the awkward market fails at once and the round one passes,
which is entry 1's lesson again.

### 3. An unfunded account could destroy a maker's liquidity

**Severity.** High. A maker lost a resting order for a trade that never
settled.

**Where.** `sut/backend/exchange.ts`.

**What happened.** The exchange matched first and settled second. An account
with no money consumed a resting order, the book changed, positions moved,
settlement threw, and the ledger never moved.

**How it was found.** An end-to-end test, then rewritten as an integration test
that names the mechanism and runs in milliseconds.

**Fixed by.** An affordability check before matching, priced at the worst price
the order could trade at.

**Now caught by.** `qe/suites/integration/settlement-atomicity.test.ts`, and one
end-to-end case kept as a smoke test.

### 4. Stops skipped the affordability check

**Severity.** High, the same failure as entry 3 by another door.

**What happened.** Entry 3's check returned early for stop orders, on the
grounds that stops are priced when they trigger. Nothing priced them then. An
unfunded stop triggered inside somebody else's order, and settlement threw after
the engine had already moved.

**How it was found.** An audit.

**Fixed by.** Checking stops at submission: a stop_limit at its limit, a
stop_market at the far side of the book or its trigger. Funds can still fall
after a stop is accepted, which is the reservation gap in
[NON-GOALS.md](NON-GOALS.md).

**Now caught by.** The stop cases in `settlement-atomicity.test.ts`.

### 5. Both engines could leave the book crossed

**Severity.** High. A bid at 105 resting over an ask at 104.

**What happened.** Both engines ran the stop cascade before resting the order
that set it off. A triggered stop_limit rested on the far side, and the
remainder then rested straight through it.

**Why nothing caught it.** The differential test compares the two engines, and
both had the same bug. The conformance test for an uncrossed book only submitted
orders that did not cross.

**How it was found.** An audit, then a property that checks each engine on its
own, with no oracle. It failed on its first run.

**Fixed by.** Finishing each order, remainder rested, before any stop it
triggered runs. SEMANTICS.md section 9 now says so.

**Now caught by.** `qe/suites/property/book-invariants.test.ts`, a conformance
case, and a saved session in the counterexample corpus.

### 6. Stops fired out of order

**Severity.** Medium. The result of a cascade depended on nesting, not on the
rule the spec states.

**What happened.** Each fired stop started a cascade of its own, so a stop that
became due later ran ahead of one that was already due. Same in both engines,
so again invisible to the differential test.

**How it was found.** An audit.

**Fixed by.** Firing stops in rounds. SEMANTICS.md section 9.

**Now caught by.** The conformance case "fires stops in rounds".

### 7. The onchain step limit could cross the book

**Severity.** Medium. A crossed book onchain, where nothing can repair it after
the fact.

**What happened.** Matching stops after 64 fills to bound gas, and the
remainder rested at its limit, through the orders it had not reached.

**How it was found.** An audit.

**Fixed by.** Refusing the whole order with `MatchStepLimitReached` if liquidity
it crosses is still there when the steps run out.

**Now caught by.** The step-limit tests in `OrderBookExchange.t.sol`, both
sides.

### 8. An unpriceable order panics instead of refusing

**Severity.** Low. Nothing is at risk; the transaction reverts.

**Where.** `placeLimitOrder`, before the balance check.

**What happened.** `quantity * price * quoteScale` overflowed. `uint128 *
uint128` fits in a `uint256`, but multiplying by `quoteScale` need not. The call
reverted with an arithmetic panic rather than a named error.

**Why it matters anyway.** A panic is indistinguishable from a contract bug at
the call site. An integrator cannot tell "this order is too large to price" from
"this exchange is broken", and the two need different responses.

**How it was found.** A unit test that used `type(uint128).max` for both
arguments, expecting `InsufficientBalance`.

**Fixed by.** An explicit guard and a `NotionalOverflow` error.

**Now caught by.** `test_AnUnpriceableOrderIsRefusedByName`.

**And again.** The guard covered the notional but not the notional plus its fee
escrow. A buy whose notional exactly fits overflowed on the sum, with the same
panic. Found while writing a test to kill a surviving mutant on the guard one
line away; caught by `test_BuyAtTheNotionalLimitIsRefusedByName`.

### 9. Trades did not name their taker, and fill counts included strangers

**Severity.** Low.

**What happened.** The contract's `Traded` event always carried a taker order id
of 0, because the id was only allocated if the order rested, so indexers could
not join a trade to its order. Separately, the REST response summed every trade
in the result as the order's fills, including trades between other orders that
its stop cascade set off.

**How it was found.** An audit.

**Now caught by.** `test_TradedCarriesTheTakerOrderId`, and a REST contract
test for an order that sets off a stop.

### 10. Event ordering could be rewritten by a reentrant token

**Severity.** Low, and dependent on a hostile or unusual token.

**What happened.** `Deposited` and `Withdrawn` were emitted after the token
transfer. A token that calls back into the exchange can interleave or reorder
the logs that offchain indexers rely on.

**How it was found.** Foundry's `reentrancy-events` lint.

**Fixed by.** Emitting before the external call.

## Planted, to prove the suites work

These were introduced by hand to check that a suite can see them.

| Mutant | Caught by |
| --- | --- |
| `moveToBack` skips the level aggregate | unit, differential |
| `reduceDisplayed` leaves the level total stale | unit, differential |
| `remove()` forgets `orderCount` | differential only |
| Price array ordering flipped | unit, differential |
| Iceberg refresh keeps queue position | unit, differential |
| Price guard deleted from fillability scan | differential only |
| Fee rounds down instead of up | ledger properties |
| Seller fee never reaches the fee account | ledger properties |
| Base created out of nothing on settlement | ledger properties |
| Buyer always charged the taker rate | ledger properties |
| Level total not reduced on fill | contract invariants |
| Unlink leaves a stale back-pointer | contract invariants |
| Fee account credited one unit too much | contract invariants |
| Matching ignores the limit price | contract invariants, after the handler was fixed |
| Offchain trades at the taker price | consistency, after quote was compared |
| Offchain charges the maker rate to the taker | consistency |
| `break` to `continue` in the fillability scan | nothing, and correctly so: an equivalent mutant, see [MUTATION.md](MUTATION.md) |

Three of these initially survived. Each survival was a gap in a suite, and each
is described in [../LESSONS.md](../LESSONS.md):

- `remove()` forgetting `orderCount` was invisible to the 104 hand-written
  tests of the time.
- Matching ignoring the limit price was invisible to the invariant suite because
  the handler swallowed the resulting reverts.
- Offchain trading at the taker price was invisible to the consistency suite
  because only base balances were compared, and base cannot see a price.

## Defects in the test equipment

A test harness can be wrong in a way that keeps the build green, which is worse
than a product bug because it hides them. The ones found so far, each written up
in [../LESSONS.md](../LESSONS.md): a property generator that produced six-command
sessions, an invariant handler that swallowed reverts, a skip decided before its
flag was set, a flake detector that never read a result, a skip guard that
grepped source text, an invariant check that failed one run in four, and a
mutation score inflated three different ways.

## Classes covered but not yet found in this system

Listed so the absence of an entry is not mistaken for the absence of a risk.
Coverage exists; these simply have not fired.

A cancelled order filling later, across sequential interleavings of cancels and
fills (there is no concurrent harness; see [NON-GOALS.md](NON-GOALS.md)). Order
quantity not conserved across partial fills. Self-trade under each STP mode.
Iceberg refresh losing time priority. Reduce-only increasing a position.
WebSocket sequence gaps across reconnect. Market data deltas failing to
reconstruct the book. Integer precision loss above 2^53 on the wire. REST and
JSON-RPC disagreeing. Insolvency of the contract. Price level list losing its
ordering.
