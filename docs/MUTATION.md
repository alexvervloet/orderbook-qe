# Mutation testing

## What it answers

Coverage tells you which lines ran. It cannot tell you whether anything checked
what those lines produced, and on a test suite full of assertions that restate
the implementation, coverage will be high and wrong.

Mutation testing asks a different question: if I break this line on purpose,
does any test notice? The answer is a kill rate, and unlike coverage it cannot
be raised by executing more code.

The gap between the two was two real bugs in this repository. Both sat in lines
with full coverage.

## How it runs here

`npm run mutate`. A hand-written runner rather than Stryker, for one reason:
this repository has to mutate Solidity as well as TypeScript and run each mutant
against whichever suite should catch it. One tool that does both, imperfectly
and legibly, beats two whose reports cannot be compared.

The operators model mistakes people actually make in exchange code: a comparison
the wrong way round, a boundary off by one, an aggregate not maintained, a fee
at the wrong rate. Mutating arbitrary tokens produces a large number of mutants
nobody learns anything from.

Comments are excluded. A mutated comment is guaranteed to survive and would
inflate the denominator with cases no test could ever kill.

## It gates nothing

No build fails because the score moved. Two reasons.

A number that blocks a merge becomes a number people optimise, and mutation
score is cheap to inflate: assertions that pin down incidental behaviour kill
mutants without checking anything a user cares about. The measure stops
measuring the moment it becomes a target.

And the raw score is not clean data. Equivalent mutants cannot be killed by any
test, so the denominator is wrong until a human has looked. Treating the
unadjusted number as a target sends someone chasing a test that cannot exist.

The report is a diagnostic. It goes to a human, who decides.

## The current result, and what it does not mean

```
engine       73/73    100%   ( 6 known equivalent, 1 killed by timeout)
book-side    22/22    100%   ( 0 known equivalent, 1 killed by timeout)
ledger        9/9     100%   ( 1 known equivalent, 0 killed by timeout)
reference    81/81    100%   ( 7 known equivalent, 2 killed by timeout)
contract     52/53     98%   ( 5 known equivalent, 1 killed by timeout)

overall     237/238    99.6% (19 equivalent mutants excluded)
```

**It is a score after triage.** The 19 exclusions are human judgements recorded
in `qe/mutation/equivalents.ts`, one argument per mutant. If an argument is
wrong, the real score is lower. A unit test fails if an entry names an operator
the runner does not have, or a mutant it no longer generates.

**The one survivor is left standing on purpose.** It is on the contract's guard
against notional plus fee escrow overflowing. Killing it needs an order whose
escrow is exactly 2^256 - 1, which no balance can fund, and the only difference
it makes is which refusal the caller sees. It is not equivalent, so it is not
excused. It is reported.

**Mutants killed by timeout** turned a loop into an infinite one. They count as
killed, because a suite that never finishes never goes green, and are flagged
separately so they are not mistaken for ordinary kills.

**It covers these operators only.** Comparison flips, boundary shifts, logical
connectives and compound assignment. It does not delete statements, reorder
them, or change constants, so there are classes of defect this number says
nothing about.

**It says nothing about the code that is not mutated.** The server, the wire
encoding, the exchange service and the frontend are not targets. Their coverage
comes from the contract and end-to-end suites and is not expressed as a kill
rate.

## The number this replaced

This page used to report 258 of 258 with 22 equivalents excluded. That number
was wrong in three ways, each of which made it higher:

- The registry excused a mutant by its line, not its operator. Listing the
  `>` on the reduce-only lines excused the `===` and `&&` mutants on the same
  lines too. All eight of those are killable, and are now killed.
- The comparison operators mutated generic type brackets. `Map<OrderId, Node>`
  became a syntax error that every suite "killed". There were 26 of these.
- The contract scored 54 of 54. With a flaky per-run invariant check removed and
  nothing persisted between runs, it scored 43 of 57. The likeliest cause is
  Foundry replaying one persisted failure against every later mutant, which the
  runner never cleared. Nine of the survivors were real gaps in the Solidity
  tests, and writing the test for one of them found a real bug. See
  [FAILURE-MODES.md](FAILURE-MODES.md).

The full account is in [../LESSONS.md](../LESSONS.md).

## What mutation testing did not find

The most useful thing about this table is not the percentage. The worst bugs in
this repository were not found by mutation testing at all:

- The escrow bug, and later the escrow dust left by its fix, were two correct
  lines that disagreed with each other. A mutation operator that flips a
  comparison cannot produce `ceil(a) + ceil(b) != ceil(a + b)`. Differential
  testing on a market whose fees do not divide evenly found the first, and an
  audit found the second.
- The crossed book was the same wrong design in both engines. Every mutant of
  either engine was killed, and the engines still agreed on a book that was
  wrong. A property that checked the book with no oracle found it.

Mutation testing measures whether the tests check the code that exists. It
cannot tell you the design is wrong.

## Equivalent mutants

A mutant that changes the source without changing behaviour. No test can detect
it, because there is nothing to detect.

`qe/mutation/equivalents.ts` is a registry of the ones found so far, each with
the argument for why it is equivalent, keyed by file, line and operator. Triage
is human work and there is no way around that. What the registry does is make
it work done once, so the next person reads an argument instead of rebuilding
it.

Every entry is a claim that can be wrong. If behaviour later changes so a listed
mutant becomes observable, the entry is a bug.

The worked example, which cost an hour and a wrong conclusion, came from a
mutant applied by hand, not by the runner, which has no statement operators:

```ts
for (const price of book.prices()) {
  if (!crosses(r, price)) break   // mutated to: continue
  total += book.level(price)!.displayedTotal
  if (total >= r.quantity) return total
}
```

`continue` looks like it would over-count and let an unfillable fill-or-kill
through. It does not. `continue` skips the accumulation line rather than
reaching it, and because the price array is sorted best-first, every price after
the first non-crossing one also fails to cross. Same total, slower route.

I recorded it as a coverage gap before reading the loop body properly. Deleting
the guard outright is the non-equivalent version of the same idea, and that one
is invisible to all hand-written unit tests and caught immediately by the
differential suite.

## Reading a survivor

A survivor is a question, not a verdict. In order:

1. **Is it equivalent?** Work out whether behaviour changed at all. If not,
   register it with the argument and move on.
2. **Is the mutated behaviour something anyone would care about?** Some
   survivors are real behaviour changes that no requirement covers. Sometimes
   the right response is a test; sometimes it is admitting the requirement does
   not exist.
3. **Otherwise it is a gap.** Write the test.

The most useful survivor this repository produced was in the ledger:
`===` became `!==` in the buyer assignment, making buyer and seller the same
account, and it survived every conservation property. Conservation is satisfied
by moving nothing. The suite asserted that totals were unchanged and never that
the two counterparties moved in opposite directions. Adding that assertion took
the ledger from 6 of 12 to 11 of 11, counted at the time with the generic-bracket
mutants still included.

## Two operational warnings

**Mutants can hang.** Flipping a loop's exit condition produces an infinite
loop. The runner kills a mutant after a timeout and counts it as killed, because
a suite that never finishes never goes green. Without the timeout, one mutant
ran for fifty minutes with a modified source file in the working tree.

**Two runs must not overlap.** The runner rewrites files in place, so a
concurrent run corrupts the other's restore. A lock file makes that a clear
error. Ctrl-C or SIGTERM stops the run between mutants, restores the source,
rebuilds the contract if it was the target, and writes no report, because a
partial score reads like a whole one.

Both are in [../LESSONS.md](../LESSONS.md), and both were found the hard way.
