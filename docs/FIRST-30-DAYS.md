# The first thirty days

How I would approach being the first quality engineer on a platform like this
one, written as a plan rather than a promise. This repository is the same plan
executed against a system I built to stand in for the real one, so the claims
here have working code behind them.

Two assumptions worth stating, because both change the plan if wrong: a public
testnet is the near-term goal, and the target is robust coverage of the most
critical 20 to 30 per cent of trading paths rather than broad coverage of
everything.

## Week 1: understand, and prove I understand

**Read the matching engine before anything else.** Not the documentation, the
code. Everything downstream is an opinion about what the engine does, and I will
be arguing with engineers about edge cases within a fortnight; I need to be
right when I do.

**Write down the matching semantics as a specification.** Every exchange has
behaviour that is real, relied upon, and unwritten: whether a fill-or-kill can
see hidden iceberg size, what self-trade prevention does to an order already
half-filled, whether an iceberg refresh keeps time priority. I write my
understanding down and take it to the engineers.

This is the highest-value week-one artifact, and its value is mostly in being
wrong. A document that is 80 per cent right produces a conversation in which
somebody says "no, it does this", and that sentence is worth more than a week of
reading. The version in this repository is
[../spec/SEMANTICS.md](../spec/SEMANTICS.md); three of its clauses exist because
writing it forced a decision that had never been made.

**Build the risk map.** Rank every trading path by blast radius, how long a
failure would go undetected, and how much the code moves. The detection axis is
the one usually left out and the one that decides whether something is an
incident or a catastrophe. See [RISK-MAP.md](RISK-MAP.md).

**Deliverables:** a written spec with open questions marked, a ranked risk map,
and a list of the behaviours nobody could answer definitively. That last list is
usually where the bugs are.

## Week 2: the first automation, aimed at the top of the map

Not a framework. One suite, against the highest-risk path, working end to end
including in CI. A framework built before any tests exist is a guess about what
tests will need.

**Differential testing against a reference implementation.** For a matching
engine this is the single highest-yield technique available, and I would start
here rather than with example-based tests. Write a naive, obviously correct
engine from the specification, then drive random order sequences through both
and compare every observable after every command.

It is the only technique on the list that finds bugs nobody thought to look for.
In this repository, two of six seeded defects were invisible to the 106
hand-written tests of the time and immediately obvious to the differential
suite, and both were cached aggregates that a human would never write an
assertion about. The full scoreboard is in [../LESSONS.md](../LESSONS.md).

It has one blind spot, and I would plan for it from the start. Two engines
written by one person from one spec can agree on something wrong. Both engines
here once left the same crossed book, and the differential suite passed
thousands of runs over it. So every rule the spec states outright, "the book is
never crossed at rest", gets a property of its own that checks one engine with
no oracle.

**Conservation properties for money.** Value in equals value out plus fees, over
any sequence. Fees round in a stated direction, always. These are cheap to write
and they cover the failures that never announce themselves.

**Deliverables:** a differential suite and a conservation suite, both running on
every pull request in under a minute.

## Week 3: the boundaries

**API contract tests across every protocol the platform speaks**, with responses
validated against published schemas rather than picked at field by field. On a
JavaScript stack I would check integer precision above 2^53 on day one, because
`JSON.parse` silently rounds and a size that comes back one unit short is a
filled order nobody asked for.

**The feed's ordering guarantee.** For a market data stream the strongest test is
reconstruction: apply every delta to the opening snapshot and require the result
to equal a freshly fetched book. One assertion covers a whole family of bugs
that would otherwise need a test each.

**Onchain, and the seam.** Contract invariants first: solvency, the book never
crossed, cached level totals matching the orders in them. Then the seam, which
is where this platform's distinctive risk lives: drive the same order sequence
through the offchain engine and the contract and require them to agree.

That suite found the worst bug in this repository, an escrow underflow that
permanently strands a trader's funds. It was invisible to the 23 contract tests of
the time, three of them fuzz tests, and eight invariants, because the default
market's numbers divided evenly and made the bug unreachable.

**Deliverables:** contract tests on all protocols, contract invariants, and
offchain/onchain consistency on every pull request, deeper nightly.

## Week 4: make it stick, and hand it over

**Tier the pipeline against measured timings**, not intuition. Fast and
deterministic on every pull request; slow and searching overnight. Budget five
minutes from push to verdict, because past that people stop waiting and start
batching, and batched changes make every failure harder to attribute. See
[CI-POLICY.md](CI-POLICY.md).

**Mutation testing, reported and never gated.** Coverage says which lines ran.
Mutation says which lines were checked, and the gap between those two is where
the confidence actually is. Gating on the score turns it into a number people
optimise.

**Make the AI workflow concrete and measured.** Not "we use AI". A triage pass
over real failures, scored against labelled outcomes, so its accuracy is a
number and its failure modes are known. See [AI-IN-QE.md](AI-IN-QE.md).

**Write down what I chose not to test.** [NON-GOALS.md](NON-GOALS.md) is the
document I would most want from a predecessor and have never been given. Without
it, the next person cannot tell a deliberate gap from an oversight, so they
either duplicate work or assume coverage that was never there.

**Deliverables:** tiered CI with quality gates, a mutation report, the written
decisions, and a roadmap to testnet.

## What I would not do in the first thirty days

**Not build a framework first.** Framework abstractions written before the tests
exist encode guesses. The abstractions in this repository, the builders, the
harness, the differential comparator, were all extracted from tests that already
worked.

**Not chase a coverage number.** 100 per cent coverage of an exchange means
nothing if the matching engine can break price-time priority silently. The
target is the flows where failure is unrecoverable, protected properly.

**Not add end-to-end tests for anything testable lower down.** Browser tests are
slow, fail for unrelated reasons, and give worse failure messages. This
repository has six, and one of them found a real bug, which was then rewritten
as an integration test that runs in milliseconds and says exactly what broke.

**Not introduce a quarantine for flaky tests.** Quarantine sounds like a
compromise and works as a graveyard. A flaky test gets one working day to be
fixed or deleted.

**Not test the frontend as a rendering surface.** The frontend risk that matters
is showing a number that disagrees with the backend, and that is an assertion
that the browser and the backend agree, not a snapshot.

## What I would be asking engineers, from week one

Not "how do I test this", but the questions that expose the undecided:

- What happens to a partially filled fill-or-kill when self-trade prevention
  cancels the liquidity it was counting on? If the answer is "that cannot
  happen", I will try to make it happen.
- Does an iceberg refresh keep its place in the queue? Most engines say no. Is
  that written down, and does the code agree with what is written?
- What is the deepest chain reorganisation we are prepared to be wrong about?
  There is no depth at which a chain is provably final, so this is a number
  somebody has to own.
- When the sequencer commits a trade and settlement then fails, what is true?
  This repository had that exact bug: matching succeeded, settlement threw, and
  the book had already changed.
- Which of these is a product decision and which is an accident? Half of what
  looks like a bug in an exchange is an undocumented decision, and it is cheaper
  to find that out in a conversation than in a test.

## What success looks like at thirty days

The critical paths from the risk map have automated coverage that runs on every
pull request in under five minutes. An engineer who breaks matching, fees or
settlement finds out from CI rather than from a trader. The decisions are
written down, including the deliberate gaps. And the roadmap to testnet says
what is covered, what is not, and what it would cost to close each remaining
gap, so that scope is somebody's decision rather than my silent assumption.
