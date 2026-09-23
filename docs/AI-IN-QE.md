# AI in quality engineering

What it is used for here, what it is measured against, and where it lost.

Everything below is reproducible: `secrun npm run ai:triage`,
`secrun npm run ai:generate`. Raw results are in `qe/ai/results/`.

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

Twelve failures that really happened while building this repository, with their
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

### Results

| Model | Correct | Accuracy | Cost per run |
| --- | --- | --- | --- |
| Haiku 4.5 | 9 / 12 | 75.0% | $0.020 |
| Sonnet 5 | 8 / 12 | 66.7% | $0.047 |

Per label, Haiku 4.5:

| Label | Precision | Recall |
| --- | --- | --- |
| `product-bug` | 100% | 100% |
| `test-bug` | 100% | 50% |
| `test-equipment` | 40% | 100% |
| `environment` | 100% | 100% |
| `equivalent` | n/a | 0% |

### What this actually says

**The cheaper model was not worse.** Sonnet 5 cost 2.4 times as much and scored
one lower. With n = 12 that difference is noise and the honest reading is that
there is no measurable advantage here, not that Haiku is better. The useful
conclusion is the decision it supports: triage runs on Haiku 4.5, and the
upgrade would have to earn its place on a bigger corpus.

**It is reliable exactly where it needs to be.** Both models got every
`product-bug` right, and neither ever labelled a product bug as an environment
problem. The dangerous error in triage is dismissing a real defect as flakiness,
and it did not happen.

**It over-predicts `test-equipment`.** Precision 40%. Every single
misclassification, across both models, was something else called
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
averaged 0.95 confidence when wrong against 0.92 when right: anti-correlated.
Sonnet 5 was 0.69 against 0.72, correctly ordered but far too close to threshold
on. Nothing in this pipeline routes on the confidence number, because measuring
it showed it does not carry information.

### How it is used

As a first pass that sorts and suggests, never as a gate. A nightly triage over
the failures a run produced, with its output attached to the report a human
reads. It is good at the bulk sorting and known to be weak at two specific
edges, and both of those weaknesses are documented above rather than discovered
later by someone trusting it.

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
2. Does it pass against correct code? A test that fails on correct code is
   wrong, and is discarded rather than fixed.
3. What share of mutants does it kill, running alone, compared with the
   hand-written suite on the same mutants?

Step 3 is the only interesting number.

### Results

See `qe/ai/results/generation.json` for the current run.

### What this cost to learn

Two failures of my own harness before any of it worked, both worth recording.

**Silent truncation.** The first run produced a file that failed to parse at
line 340. Adaptive thinking shares the `max_tokens` budget with the text, so the
response was cut off mid-literal, and my fence-stripper required a closing fence
and silently wrote the truncated body when it did not find one. A truncated file
looks exactly like a badly written one three steps later. The runner now checks
`stop_reason` explicitly and treats `max_tokens` as a failed run.

**A model that answered in prose.** Offered a tool and left to choose, Sonnet 5
answered one of twelve triage cases in text instead of calling it. Forcing the
tool fixed it and also moved schema enforcement server-side. A structured step
that fails on one input in twelve because the answer arrived in the wrong shape
is not a structured step.

## Model choice

Sonnet 5 for authoring, Haiku 4.5 for classification. Opus is deliberately not
used: it costs several times more and there is no evidence in this repository
that it would do either job better, which is the only argument that should buy a
more expensive model.

## Spend control

Every run counts tokens through the API before sending, prints an estimate, and
tracks actual spend against a limit that defaults to $0.25. Exceeding it throws.

This is not frugality theatre. A generation loop that retries on failure is a
loop that can spend money without anyone watching, and the guard is what makes
it safe to run unattended in a nightly job.

## What AI is not used for here

**Not as a gate.** Nothing merges or blocks on a model's output. Every AI step
produces a suggestion attached to something a human reads.

**Not for generating the reference engine.** The oracle's entire value is being
independently derived from the specification and obvious on inspection. A
generated oracle shares failure modes with generated tests, and the differential
suite would then be comparing two things that can be wrong in the same way.

**Not for writing assertions about money.** The fee rounding rule, the
conservation properties and the escrow arithmetic are hand-written. These are
the cases where a plausible-looking wrong assertion is most expensive and
hardest to spot in review.

**Not for triaging equivalent mutants**, for the reason measured above.
