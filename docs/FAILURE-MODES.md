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
the ceiling never does anything. 23 Solidity unit tests, three fuzz tests and
eight invariants all passed, because on that market the buggy formula and the
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

**Fixed by.** `_feePerLot`, which charges a ceiling per lot instead of on the
total. Locking and releasing then perform the same arithmetic in a different
order, which always balances. It escrows marginally more than the fee will be,
and the surplus returns on settlement.

**Now caught by.** `sut/contracts/test/FeeRounding.t.sol`, two direct tests, and
the awkward-market consistency suite.

**The transferable part.** A market's parameters are test inputs. Choosing round
numbers for the default market made an entire class of arithmetic bug
unreachable by every test that used it. Any suite for a system with fees needs
at least one configuration where the fees do not divide evenly.

### 2. An unpriceable order panics instead of refusing

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

### 3. Event ordering could be rewritten by a reentrant token

**Severity.** Low, and dependent on a hostile or unusual token.

**What happened.** `Deposited` and `Withdrawn` were emitted after the token
transfer. A token that calls back into the exchange can interleave or reorder
the logs that offchain indexers rely on.

**How it was found.** Foundry's `reentrancy-events` lint.

**Fixed by.** Emitting before the external call.

## Planted, to prove the suites work

These were introduced deliberately to check that a suite can see them. Results
are in [../LESSONS.md](../LESSONS.md).

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
| `break` to `continue` in the fillability scan | nothing, and correctly so: equivalent mutant |

Three of these initially survived. Each survival was a gap in a suite, and each
is described in [../LESSONS.md](../LESSONS.md):

- `remove()` forgetting `orderCount` was invisible to 104 hand-written tests.
- Matching ignoring the limit price was invisible to the invariant suite because
  the handler swallowed the resulting reverts.
- Offchain trading at the taker price was invisible to the consistency suite
  because only base balances were compared, and base cannot see a price.

## Classes covered but not yet found in this system

Listed so the absence of an entry is not mistaken for the absence of a risk.
Coverage exists; these simply have not fired.

Cancel racing a fill. Crossed book at rest. Order quantity not conserved across
partial fills. Self-trade under each STP mode. Iceberg refresh losing time
priority. Stop cascade ordering. Reduce-only increasing a position. WebSocket
sequence gaps across reconnect. Market data deltas failing to reconstruct the
book. Integer precision loss above 2^53 on the wire. REST and JSON-RPC
disagreeing. Insolvency of the contract. Price level list losing its ordering.
