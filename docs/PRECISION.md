# Precision

Why there is no floating point anywhere near a price, a size or a balance, and
what the codebase does instead.

## The rule

Every price is an integer count of ticks. Every quantity is an integer count of
lots. Every balance is an integer count of an asset's smallest unit. In
TypeScript they are `bigint`; in Solidity they are `uint128` and `uint256`; on
the wire they are decimal strings.

There is no representation anywhere in this system capable of holding a fraction
of a unit. That is the only reliable way to stop one appearing.

## Why not floats, concretely

`0.1 + 0.2` is `0.30000000000000004`. That is well known and is not really the
problem, because nobody writes that line. The problem is that the error is
invisible, accumulates, and shows up as an exchange that owes slightly more than
it holds, discovered during a reconciliation weeks later.

A book keyed by floating-point price is worse than a book with rounding errors.
Two orders intended for the same price level can land on different keys, and
then price-time priority is silently wrong: the second order rests at its own
private level instead of queueing behind the first. Nothing errors, nothing
looks odd in the book, and one client is being served out of turn.

## Why not `number`, even for integers

JavaScript numbers are exact integers only up to 2^53 - 1. Above that they
round, silently:

```
Number("9007199254740993")  // 9007199254740992
```

For an exchange denominating in an 18-decimal asset, 2^53 units is about
0.009 of one token. Balances pass that on the first deposit anyone makes.

This is not hypothetical for a JavaScript stack: `JSON.parse` produces numbers
by default, so a size sent as a JSON number is rounded before any application
code sees it. There is no error and no warning. The client asked for one size
and got another.

Asserted by `qe/suites/contract/rest.test.ts`, which round-trips
`9007199254740993` through the API and requires it back exactly, and separately
asserts that the same value through a JSON number loses a unit.

## Why decimal strings on the wire

JSON has one numeric type and it is a double. `bigint` cannot be serialised by
`JSON.stringify` at all; it throws, which at least is loud.

Every integer crossing the network is therefore a decimal string, encoded in one
place (`sut/backend/wire.ts`) so no route can forget. A JSON number in a
quantity field is rejected at the edge with a 400 rather than coerced, because
accepting it means accepting silent precision loss and there is no way to tell
afterwards whether a value was affected.

## Rounding, where it is unavoidable

Division cannot always be exact, so fees need a rounding rule. Rounding is
always **up**, in the exchange's favour, via `ceilDiv`.

Round-to-nearest is the intuitive choice and is wrong here. Over enough trades
it produces occasions where the fee account pays out more than it took in, and a
fee account that can go negative is a hole in the balance sheet nobody is
watching. Rounding up costs each client at most one indivisible unit more than
the exact fee.

The rule is asserted as a property, not documented and hoped for:

- A charged fee is never below the exact proportional fee.
- It is never more than one unit above it.
- It equals the exact fee whenever the division is exact.

Stated as a bound rather than as a formula, so the test catches both a wrong
rounding direction and an arithmetic slip that happens to round the right way.

## Where this was nearly not enough

Getting the units right is necessary and not sufficient. The escrow bug in
[FAILURE-MODES.md](FAILURE-MODES.md) was entirely integer arithmetic, correctly
rounded, and still wrong: the fee was rounded up once on an order total and then
released rounded up per fill, and `ceil(a + b)` is not `ceil(a) + ceil(b)`. It
stranded funds permanently.

Integer arithmetic removes a class of bug. It does not remove the need to check
that two calculations of the same quantity agree.

The related trap is choosing convenient scales for a fixture. This repository's
default market divides evenly at every step, which made the escrow bug
unreachable by every test that used it. There is a second market configured with
awkward scales for exactly this reason.
