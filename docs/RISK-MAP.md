# Risk map

Which parts of an exchange get protected first, and the reasoning that put them
in that order.

The target is not coverage. The target is that the failures which would be
unrecoverable are the ones that cannot happen quietly. A bug that loses a
customer's money and is only noticed in a weekly reconciliation is in a
different category from a bug that renders the wrong number on a chart, and the
test budget should reflect that rather than treating both as one defect each.

## How paths are scored

**Blast radius** is what one occurrence costs.

- 5, irreversible loss of customer funds, or a wrong onchain state that cannot
  be unwound.
- 4, incorrect execution: a fill that should not have happened, a price that was
  not the best available, a position the client did not ask for.
- 3, correct execution reported incorrectly, so clients act on a wrong picture.
- 2, availability: correct behaviour that clients cannot reach.
- 1, cosmetic.

**Detection difficulty** is how long it would run before anyone noticed. This is
the axis usually left out, and it is the one that decides whether a bug is an
incident or a catastrophe. A matching engine that crashes is found in seconds. A
fee rounding error in the wrong direction is found by an auditor, or never.

- 5, silent: no alarm fires, state stays internally consistent, only an external
  reconciliation reveals it.
- 3, visible in aggregate: metrics drift, someone eventually asks.
- 1, loud: errors, crashes, failed requests.

**Likelihood** is how much the code moves and how much concurrency it carries.

Priority is blast radius x detection difficulty x likelihood. The ranking below
is the result, not an intuition written up afterwards.

## The ranking

| # | Path | Blast | Detect | Likely | Score | Tier |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Matching correctness: priority, execution price, fills | 4 | 5 | 5 | 100 | **Protect first** |
| 2 | Backend state against onchain settled state | 5 | 4 | 5 | 100 | **Protect first** |
| 3 | Fee and settlement arithmetic | 5 | 5 | 3 | 75 | **Protect first** |
| 4 | Cancel against concurrent fill | 4 | 4 | 4 | 64 | **Protect first** |
| 5 | Order lifecycle accounting: partial fills, remainders | 4 | 4 | 4 | 64 | **Protect first** |
| 6 | Reduce-only and position limits | 4 | 4 | 3 | 48 | **Protect first** |
| 7 | WebSocket book feed: sequencing, gaps, reconnect | 3 | 4 | 4 | 48 | Second |
| 8 | Reorg and settlement reversal | 5 | 3 | 2 | 30 | Second |
| 9 | Stop-order triggering and cascades | 4 | 3 | 2 | 24 | Second |
| 10 | Self-trade prevention | 3 | 4 | 2 | 24 | Second |
| 11 | Iceberg display and refresh | 3 | 4 | 2 | 24 | Second |
| 12 | Behaviour under load: latency, backpressure | 2 | 3 | 4 | 24 | Second |
| 13 | REST API contract stability | 3 | 2 | 4 | 24 | Second |
| 14 | Deposit and withdrawal | 5 | 2 | 2 | 20 | Second |
| 15 | Frontend rendering of book and fills | 2 | 2 | 5 | 20 | Later |
| 16 | Auth and session handling | 3 | 1 | 3 | 9 | Later |
| 17 | Historical data and charting | 1 | 2 | 4 | 8 | Later |
| 18 | Admin and operational tooling | 2 | 2 | 2 | 8 | Later |

## The first 20 to 30 per cent

Rows 1 to 6 are where the work goes before a public testnet. They are six of
eighteen paths, a third by count and considerably less than a third by surface,
and they hold every case where the platform could be wrong about money without
anyone finding out.

What ties them together is the detection column. Each one can fail while every
service stays up, every request returns 200, and every dashboard stays green.
Matching that silently breaks price-time priority looks exactly like matching
that works. A fee rounding error in the wrong direction looks like revenue. A
backend that has drifted from onchain state looks fine right up to the
withdrawal that cannot be honoured.

Rows 7 to 14 are real and will be covered, after. Most of them fail loudly. A
WebSocket feed that gaps produces a visibly wrong book and a support ticket
within minutes. That is a bad hour, not a bad quarter.

## What each of the first six gets

**1. Matching correctness.** A second implementation. The reference engine in
`qe/model` is naive and obvious; the production engine has the data structures.
Random sessions run through both and every observable is compared after every
command. This is the only technique on the list that finds bugs nobody thought
to look for, and the [mutant scoreboard](../LESSONS.md) shows two of six seeded
bugs were invisible to 106 hand-written tests and obvious to the differential.

**2. Backend against onchain.** A reconciler that runs after randomized trading
sessions and asserts three-way agreement between what the frontend renders, what
the backend has stored, and what the contract holds. Run under fault injection,
because the interesting divergence appears when something fails mid-settlement
rather than in the happy path.

**3. Fee and settlement arithmetic.** Property tests for conservation: value in
equals value out plus fees, over any sequence, always. Integer arithmetic
throughout, with rounding direction asserted rather than assumed. See
[PRECISION.md](PRECISION.md).

**4. Cancel against concurrent fill.** The canonical exchange race. Interleaved
operations against invariants, not example-based tests, because the failing
interleaving is never the one anybody writes down.

**5. Order lifecycle accounting.** Every order's quantity is accounted for at
all times: filled plus remaining plus cancelled equals submitted. Checked as an
invariant after every command in the property suite rather than asserted at the
end of a scenario.

**6. Reduce-only and position limits.** A position that grows when an order said
it would only shrink is a risk-limit breach dressed as a fill.

## When this gets rewritten

This ranking is a claim about a system that has not run in production yet.
Detection difficulty in particular is a guess. The first real incident is worth
more than the whole table, and the table gets rewritten the day one lands.

Explicitly revisit when: the first incident happens, perpetuals or margin ship
(liquidation would enter at or near the top), a market maker integrates by API
(row 13 moves up sharply), or the matching engine is rewritten for throughput,
which resets row 1's likelihood to maximum.
