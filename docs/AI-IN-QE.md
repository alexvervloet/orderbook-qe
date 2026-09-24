# AI in quality engineering

What it is used for here, what it is measured against, and where it lost.

Everything below is reproducible with an API key in `ANTHROPIC_API_KEY`:
`npm run ai:triage`, `npm run ai:triage -- --model claude-sonnet-5`, and
`AI_MAX_SPEND_USD=1 npm run ai:generate` (see [Spend control](#spend-control)
for why generation needs the limit raised). Raw results are in
`qe/ai/results/`, one file per model for triage.

## The rule this follows

Any claim about an AI-assisted workflow has to come with a number, or it is not
a claim. "We use AI for failure analysis" cannot be checked, cannot be improved,
and cannot be handed to anyone else.

So both tracks here are scored against something external. Triage is graded
against labels assigned by hand, after the real cause was known. Generation is
graded by mutation kill rate, because generated tests always look convincing and
only a mutant can tell a real assertion from one that restates the
implementation.

## Track A: failure triage

### Method

Ten failures that really happened while building this repository, with their
evidence as an engineer would see it: the output, the timings, the symptoms.
Each was labelled by hand afterwards, once the cause was established.

The labels are the categories that decide what happens next, which is the only
useful thing a triage step can produce:

| Label | Means | Next action |
| --- | --- | --- |
| `product-bug` | The system is wrong | Fix the product |
| `test-bug` | The assertion is wrong | Fix the test |
| `test-equipment` | The harness is not exercising what it claims | Fix it, and distrust every green run since |
| `environment` | Neither; infrastructure misbehaved | Fix the environment |
| `equivalent` | A mutation that cannot change behaviour | Nothing |

`test-equipment` is separated from `test-bug` deliberately. A broken assertion
fails loudly. Broken equipment passes, which is far worse, and the response is
different: you have to go back and disbelieve earlier results.

### A correction

The first published version of this page scored twelve cases and called all of
them real. Two were invented: a port collision under parallel workers, and an
empty price level left behind by a cancel. Haiku 4.5 labelled both correctly and
Sonnet 5 one of them, so they moved the ranking: 9 of 12 against 8 of 12 became
a tie. Worse than the numbers, a corpus that includes the failures its author
imagined measures how well a model recognises imagined failures, which is the
thing this corpus exists to avoid.

The two are gone from `qe/ai/corpus.ts`. The scores below are recomputed from
the per-case verdicts the original runs recorded in `qe/ai/results/`, with the
two invented cases left out, so no model was run again. The next run scores the
ten directly.

### Results

| Model | Correct | Accuracy | Cost of the recorded run |
| --- | --- | --- | --- |
| Haiku 4.5 | 7 / 10 | 70% | $0.020 |
| Sonnet 5 | 7 / 10 | 70% | $0.047 |

The costs are for the original twelve-case runs.

Per label:

| Label | Haiku 4.5 precision | Haiku 4.5 recall | Sonnet 5 precision | Sonnet 5 recall |
| --- | --- | --- | --- | --- |
| `product-bug` | 2 / 2 | 2 / 2 | 1 / 1 | 1 / 2 |
| `test-bug` | 2 / 2 | 2 / 4 | 3 / 4 | 3 / 4 |
| `test-equipment` | 2 / 5 | 2 / 2 | 2 / 4 | 2 / 2 |
| `environment` | 1 / 1 | 1 / 1 | 1 / 1 | 1 / 1 |
| `equivalent` | none predicted | 0 / 1 | none predicted | 0 / 1 |

### What this actually says

**The cheaper model was not worse.** On the real cases the two tie, and Sonnet 5
cost 2.4 times as much. With n = 10 a tie is all this can say; it does not show
Haiku is better. The decision it supports is that triage runs on Haiku 4.5, and
the upgrade would have to earn its place on a bigger corpus.

**The expensive model made the dangerous mistake.** The worst error in triage is
dismissing a real defect, because it sends the fix to the wrong place and the
bug ships. Haiku 4.5 got both product bugs right. Sonnet 5 called one of them,
the contract's overflow panic, a test bug: it argued the test's inputs were
unrealistic and the assertion should be loosened, which is exactly the wrong
response. One miss in two cases is too few to rank the models on, and it is the
reason triage output here is a suggestion and never a gate.

**It over-predicts `test-equipment`.** Haiku 4.5 is right about it two times in
five. Every Haiku miss, and two of Sonnet 5's three, was something else called
`test-equipment`. The models are good at noticing that a suite is not exercising
what it claims and poor at telling that apart from a test that is simply wrong.

**It cannot recognise an equivalent mutant.** Zero recall, both models. Asked
about a `break`-to-`continue` mutation that provably cannot change behaviour,
both called it a coverage gap, and Sonnet 5 stated confidently that it *was* an
observable behavioural change. It is not.

That is the most useful finding here, because it is a boundary rather than a
score. The judgement "no test could catch this" requires reasoning about whether
two programs are equivalent, and the model reliably substitutes the easier
question "do the current tests catch this". Those give the same answer most of
the time and opposite answers exactly when it matters. Equivalent-mutant triage
stays human, and the registry in `qe/mutation/equivalents.ts` exists so that
work is done once.

**Confidence is not usable, and on one model is worse than useless.** Haiku 4.5
averaged 0.95 confidence when wrong against 0.91 when right: anti-correlated.
Sonnet 5 was 0.67 against 0.71, correctly ordered but far too close to threshold
on. Nothing in this pipeline routes on the confidence number, because measuring
it showed it does not carry information.

### How it would be used

As a first pass that sorts and suggests, never as a gate: run over a nightly
job's failures, with its output attached to the report a human reads. That job
does not exist yet. What exists is the scored harness that says it is worth
building and where not to trust it: good at the bulk sorting, weak at two
specific edges, and capable of the dangerous error above.

## Track B: test generation

### Method

The model is given the written specification and the module's public surface,
and asked for a Vitest suite. It is deliberately **not** given the existing
tests, because a model shown the hand-written suite produces a paraphrase of it,
and a paraphrase cannot find anything the original missed.

What comes back is held to the same bar as anything a person writes here:

1. Does it typecheck? One repair round is allowed, with the compiler's own error
   fed back, because that is the workflow a person actually uses. Editing the
   file myself is not allowed; the repair count is reported instead.
2. Does it pass against correct code? One more repair round is allowed, with the
   failing output fed back. A test still failing after that is wrong, and is
   discarded rather than fixed by hand.
3. What share of mutants does it kill, running alone, compared with the
   hand-written suite on the same mutants?

Step 3 is the only interesting number.

### Results

Target: the ledger. Model: Sonnet 5. Cost: $0.23.

| | Result |
| --- | --- |
| Typecheck | Failed, then passed after one repair round |
| Against correct code, before the second round | 25 passed, 1 failed |
| After the second repair round | 26 passed, 0 failed |
| **Mutation kill rate, generated suite** | **7 / 9 = 78%** |
| **Mutation kill rate, hand-written suite** | **9 / 9 = 100%** |

The run itself reported 11 of 13 against 13 of 13. Four of those thirteen were
not real mutants: the mutation runner, at the time, also mutated the brackets
in `new Map<AccountId, bigint>()`, producing syntax errors that both suites
"killed". Neither survivor was one of them, so on real mutants the result is 7
of 9 against 9 of 9. See [MUTATION.md](MUTATION.md).

### What it got right, and what it missed

The generated suite is not bad. 26 tests that pass, cover the rounding rule in
both directions, exercise conservation, and check the boundary above 2^53
because the prompt asked for it. Read in review it would look thorough, and it
mostly is.

It missed two mutants, and the two are the interesting part:

**`if (base < 0n || quote < 0n)` becoming `&&`.** The model tested a negative
deposit, but not each asset separately. With `&&` the guard only fires when both
are negative, so a test that passes `(-1, -1)` passes either way. Catching it
needs a test per asset, and the reason to write one is not obvious from the
specification; it is obvious from thinking about how the line could be wrong.

**`if (held < amount)` becoming `<=`.** The overdraft guard at the exact
boundary, where a trader spends their balance down to precisely zero. The model
tested a buyer with too little and a buyer with plenty, and not the buyer with
exactly enough.

One is a boundary and one is a logical connective, and both are on a guard: the
line whose whole job is to refuse. Both were missing from my hand-written suite
too until mutation testing pointed at them. That is the honest version of this
result: the model's blind spots were the same as mine, and the thing that found
them in both cases was mutation testing rather than either of us being careful.

### What the one-shot failures looked like

Worth recording, because the failure mode is specific and it is not the one
people expect.

`feeOf` takes `(notional, bps)`, and the model passed an already-multiplied
product as the first argument with `10_000` as the second, which is a 100% fee.
Its own comments gave it away: one read `notional * bps = 1001 -> /10000 =
0.1001 -> ceil = 1` above a call that passes `1001` as the notional.

So the model had understood the rounding rule from the specification exactly
right, and got the function's signature wrong. That is why a pass count is a
poor quality signal on its own: one misreading can fail several tests at once,
and several passes can rest on one correct reading.

### The conclusion I would actually act on

Generated tests are worth having and are not worth trusting. On this module they
caught 7 of the 9 mutants the hand-written suite catches, for $0.23 and two
repair rounds, and the shortfall was entirely on the guards: the cases a
specification does not spell out and a careful person finds by asking how the
line could be wrong. One module and one run is a small sample, and the number
should be read as that.

The workflow that follows is: generate, then run mutation against what came
back, and treat the surviving mutants as the review comments. That is cheaper
than reviewing generated tests by reading them, and it catches the thing reading
does not, which is a test that looks right and checks nothing.

### What this cost to learn

Two failures of my own harness before any of it worked, both worth recording.

**Silent truncation.** The first run produced a file that failed to parse at
line 340. Adaptive thinking shares the `max_tokens` budget with the text, so the
response was cut off mid-literal, and my fence-stripper required a closing fence
and silently wrote the truncated body when it did not find one. A truncated file
looks exactly like a badly written one three steps later. The runner now checks
`stop_reason` explicitly and treats `max_tokens` as a failed run.

**A model that answered in prose.** Offered a tool and left to choose, Sonnet 5
answered one of the twelve triage cases of the time in text instead of calling
it. Forcing the tool fixed it and also moved schema enforcement server-side. A
structured step that fails on one input in twelve because the answer arrived in
the wrong shape is not a structured step.

## Model choice

Sonnet 5 for authoring, Haiku 4.5 for classification. Opus is deliberately not
used: it costs several times more and there is no evidence in this repository
that it would do either job better, which is the only argument that should buy a
more expensive model.

## Spend control

Every run counts tokens through the API before sending and prints an estimate.
Before each call it also checks that the call's worst case, its input plus the
full output budget, fits under a limit that defaults to $0.25, and refuses to
send it otherwise. After each call it records what was actually spent.

The worst-case check was added late. The first version only checked after each
call, so a single generation call, which can cost $0.32 at its 32,000-token
output budget, could go straight through the limit before anything noticed. A
generation run now needs `AI_MAX_SPEND_USD` raised on purpose, which is the
point: a loop that retries on failure is a loop that can spend money without
anyone watching.

## What AI is not used for here

**Not as a gate.** Nothing merges or blocks on a model's output. Every AI step
produces a suggestion attached to something a human reads.

**Not for generating the reference engine.** The oracle's entire value is being
independently derived from the specification and obvious on inspection. A
generated oracle shares failure modes with generated tests, and the differential
suite would then be comparing two things that can be wrong in the same way.

**Not for writing assertions about money**, unaided. The fee rounding rule, the
conservation properties and the escrow arithmetic are hand-written. The
measurement above is the argument: on the ledger specifically, the generated
suite missed the overdraft boundary, and the overdraft boundary is where an
exchange either refuses a trade or lets an account go negative. The
hand-written suite is not immune either: its test of which account pays which
fee was loose enough to pass with the two fees swapped, until an audit
tightened it.

**Not for triaging equivalent mutants**, for the reason measured above.
