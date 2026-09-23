# Ledger and fee semantics

The engine turns orders into trades. The ledger turns trades into balance
changes. Keeping them apart means a matching counterexample is about matching,
not about accounting.

## Units

A market declares three integers and no decimals anywhere:

- `quoteScale`: quote units moved per lot per tick. Notional for a trade is
  `quantity * price * quoteScale`, exactly, in integer quote units.
- `baseScale`: base units per lot.
- `makerFeeBps`, `takerFeeBps`: fee in basis points.

Every quantity below is an integer count of the smallest indivisible unit of its
asset, the way a chain holds it. There is no representation in this system
capable of holding a fraction of a unit, which is the only reliable way to
prevent one from appearing.

## Settlement of one trade

Given a trade of `quantity` lots at `price` ticks:

```
notional   = quantity * price * quoteScale
baseAmount = quantity * baseScale
takerFee   = ceilDiv(notional * takerFeeBps, 10000)
makerFee   = ceilDiv(notional * makerFeeBps, 10000)
```

If the taker bought: the taker gains `baseAmount` base and loses `notional`
quote, the maker loses `baseAmount` base and gains `notional` quote. If the
taker sold, the directions swap. Both sides then pay their fee in quote to the
fee account.

## Rounding

Fees round **up**, always, in the exchange's favour.

This is a decision, not an accident, and it is the reason `ceilDiv` exists
rather than a division. Rounding to nearest is the intuitive choice and it is
wrong here: over enough trades it produces occasions where the fee account pays
out more than it took in, and a fee account that can go negative is a hole in
the balance sheet that nobody is watching.

Rounding up means every client pays at most one indivisible unit more than the
exact fee. The direction is asserted by a test, not documented and hoped for.

## The invariants

These hold after every trade, without exception, and are checked as properties
over random trade sequences rather than in examples.

**Base conservation.** The sum of base balances across every account is
unchanged by any trade. Matching moves base between accounts and never creates
or destroys it.

**Quote conservation.** The sum of quote balances across every account, plus the
fee account, is unchanged by any trade. Fees move quote from clients to the
exchange; they are not a leak.

**Fee monotonicity.** The fee account never decreases. A rebate would break
this, and if maker rebates are introduced this invariant has to be restated
before the code is written, not after a test goes red.

**Fee correctness.** A fee is never less than the exact proportional fee, and
never more than the exact fee plus one unit. This is the rounding rule stated as
a bound, which catches both a wrong rounding direction and an arithmetic slip
that happens to round the right way.

**Non-negativity.** No account balance is ever negative. The ledger is the last
line, not the first: a trade that would overdraw an account means something
upstream failed to reserve funds, so the ledger rejects it and says so loudly
rather than carrying a negative and letting it net out later.

## What the ledger does not do

It does not reserve funds when an order is placed, and so it cannot by itself
prevent an overdraw; it can only refuse one. Reservation belongs with the risk
layer. See [../docs/NON-GOALS.md](../docs/NON-GOALS.md).
