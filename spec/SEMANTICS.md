# Matching semantics

The behaviour both engines must implement. Tests assert against this document.
If a test and this document disagree, one of them is a bug and the disagreement
gets resolved here first.

Written before either engine, so that "the test agrees with the code" is never
the reason a test passes.

## 1. Units

Price is an integer count of ticks. Quantity is an integer count of lots. No
value in the matching path is a float, a decimal string, or a number that needs
rounding to compare. Two prices are equal when the integers are equal.

Rationale in [../docs/PRECISION.md](../docs/PRECISION.md).

## 2. Priority

Resting orders are ranked by price first, then by arrival sequence.

- Bids: higher price is better. Asks: lower price is better.
- Within one price level, the lower sequence number is better.
- A resting order's sequence never changes while it rests, with one exception:
  an iceberg refresh, see section 8.

## 3. Crossing and execution price

An incoming buy matches resting asks priced at or below its limit price. An
incoming sell matches resting bids priced at or above its limit price. A market
order has no price limit.

**Every trade executes at the resting maker's price**, never the taker's. A buy
limit at 105 hitting a resting ask at 101 trades at 101. The taker gets the
price improvement.

At rest, the book is never crossed: the best bid is strictly below the best ask.
An engine that can produce a crossed book at rest is broken regardless of what
else it does.

## 4. Time in force

**GTC.** Matches what it can, then rests with the remainder.

**IOC.** Matches what it can, then cancels the remainder. Never rests. A fully
unfilled IOC produces no trades and no resting order, and is not a rejection.

**FOK.** If the full quantity cannot be filled immediately against currently
available liquidity, nothing happens at all: no trades, no resting order,
outcome `rejected` with reason `fok_not_fully_fillable`. Partial execution of a
FOK is the single worst bug this engine could have, because it leaves the client
with a position it did not ask for.

Fillability for FOK is judged against *displayed* quantity only. Hidden iceberg
size does not count toward filling a FOK. This is a deliberate choice, not an
oversight: see [../docs/NON-GOALS.md](../docs/NON-GOALS.md).

## 5. Order types

**limit.** Requires a price. Honours its time in force.

**market.** Price must be null. Matches down the book until the quantity is
exhausted or liquidity runs out. Never rests; any unfilled remainder is
cancelled. A market order submitted with TIF `GTC` is treated as IOC rather than
rejected, because resting is impossible for it. Submitting a market order
against an empty book is not an error: it produces zero trades.

**stop_market, stop_limit.** Require a trigger price. Do not enter the book on
submission; they wait in a trigger set and the outcome is `triggered_later`.
See section 9.

## 6. Post-only

A post-only order that would match any resting liquidity on arrival is rejected
with `post_only_would_cross`. It never produces a trade and never rests. It is
rejected on *would cross*, not on *did cross*, so the check happens before any
matching.

Post-only with TIF `IOC` or `FOK` is contradictory, and is rejected with
`post_only_would_cross` only if it crosses; otherwise the IOC still cannot rest,
so it is cancelled unfilled. This combination is accepted rather than validated
away, because real clients send it by accident and the behaviour must be
defined.

## 7. Self-trade prevention

When an incoming order is about to match a resting order from the same account,
the incoming order's `stpMode` decides:

- `none`: the trade happens. Accounts may trade with themselves.
- `cancel_taker`: the incoming order is cancelled at that point. Trades already
  executed against *other* accounts stand.
- `cancel_maker`: the resting order is cancelled and removed, and the incoming
  order continues matching against the next resting order.
- `cancel_both`: the resting order is cancelled and the incoming order stops.

STP is evaluated per match attempt, not once per order. An order can cancel
several of its own resting orders under `cancel_maker` before finishing.

## 8. Iceberg orders

An order with `displayQuantity` set shows only that much at its price level.

- Only displayed quantity is matchable in a single pass.
- When the displayed slice is fully consumed and hidden quantity remains, a new
  slice of up to `displayQuantity` is created **at the back of the queue for
  that price level**, with a new sequence number. Refreshing costs time
  priority. This is the behaviour most engines implement and the one most likely
  to be got wrong.
- `displayQuantity` must be greater than zero and not greater than `quantity`,
  otherwise `invalid_display_quantity`.
- A taker large enough to sweep several refreshes matches the refreshed slices
  only after any other orders that were already queued behind the original.

## 9. Stop orders

Stops trigger on the last trade price.

- A buy stop triggers when the last trade price is at or above its trigger.
- A sell stop triggers when the last trade price is at or below its trigger.
- Triggering is evaluated after each trade, and a trade caused by a triggered
  stop can itself trigger further stops. Cascades are resolved to completion
  before the engine returns.
- On trigger, `stop_market` becomes a market order and `stop_limit` becomes a
  limit order at its `price`. Both keep their original time in force.
- Stops triggered in the same cascade are processed in ascending sequence order,
  so the result does not depend on iteration order of an internal map.
- A stop that has not triggered can be cancelled and is invisible in the book
  snapshot.

## 10. Reduce-only

A reduce-only order may never increase the magnitude of the account's open
position in the market.

- Position is zero: rejected, `reduce_only_no_position`.
- Position is on the same side as the order: rejected,
  `reduce_only_wrong_side`. A reduce-only buy is only valid against a short.
- Position is on the opposite side: the order quantity is capped at the absolute
  position size. The cap is applied at submission, against the position as it
  stands at that moment.

## 11. Cancel

Cancel is idempotent. Cancelling an unknown, already filled, or already
cancelled order returns `cancelled: false` and is not an error.

A cancelled order never appears in a later trade. An engine that can fill a
cancelled order has a race, and the concurrency suite exists to find exactly
that.

## 12. Validation

Checked before anything else, in this order, so that the first failure is
deterministic:

1. `duplicate_order_id` if the id is already known, live or historic.
2. `invalid_quantity` if quantity is not greater than zero.
3. `invalid_price` if a limit order has a null or non-positive price, or a
   market order has a non-null price.
4. `invalid_trigger_price` if a stop has a null or non-positive trigger, or a
   non-stop has a non-null trigger.
5. `invalid_display_quantity` per section 8.

## 13. What the engine does not do

The engine does not hold balances, charge fees, or settle. It turns orders into
trades. Fees and balances are the ledger's job, and are specified in
[LEDGER.md](LEDGER.md). Keeping them apart means the differential test can
compare matching behaviour without dragging accounting into every counterexample.
