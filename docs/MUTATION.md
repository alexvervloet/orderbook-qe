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

## Equivalent mutants

A mutant that changes the source without changing behaviour. No test can detect
it, because there is nothing to detect.

`qe/mutation/equivalents.ts` is a registry of the ones found so far, each with
the argument for why it is equivalent. Triage is human work and there is no way
around that; what the registry does is make it work done once, so the next
person reads an argument instead of rebuilding it.

Every entry is a claim that can be wrong. If behaviour later changes so a listed
mutant becomes observable, the entry is a bug.

The worked example, which cost an hour and a wrong conclusion:

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
the ledger from 6 of 12 to 11 of 11.

## Two operational warnings

**Mutants can hang.** Flipping a loop's exit condition produces an infinite
loop. The runner kills a mutant after a timeout and counts it as killed, because
a suite that never finishes never goes green. Without the timeout, one mutant
ran for fifty minutes with a modified source file in the working tree.

**Two runs must not overlap.** The runner rewrites files in place, so a
concurrent run corrupts the other's restore. A lock file makes that a clear
error. Interrupting a run releases the lock and prints a warning to check
`git status`, because a mutant left in the tree is a defect that was never
committed and is very confusing to debug.

Both are in [../LESSONS.md](../LESSONS.md), and both were found the hard way.
