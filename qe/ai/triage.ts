/**
 * Track B: AI failure triage, scored against labelled outcomes.
 *
 * Asks the model to put each failure into the category that decides what
 * happens next, and grades the answers against labels assigned by hand once
 * the real cause was known.
 *
 * The score is the point. "I use AI to analyse failures" is unfalsifiable.
 * "It agrees with my labels on N of 12, and the ones it misses are all of one
 * kind" is a claim that can be checked and acted on.
 *
 *   ANTHROPIC_API_KEY=... npm run ai:triage
 *   ANTHROPIC_API_KEY=... npm run ai:triage -- --model claude-sonnet-5
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import {
  countInputTokens,
  createClient,
  estimateCost,
  MAX_SPEND_USD,
  MODELS,
  SpendTracker,
} from './client.ts'
import { FAILURE_CORPUS, type FailureLabel, type LabelledFailure } from './corpus.ts'

const LABELS: readonly FailureLabel[] = [
  'product-bug',
  'test-bug',
  'test-equipment',
  'environment',
  'equivalent',
]

const SYSTEM = `You triage failing builds on an onchain order-book exchange.

Classify each failure into exactly one category. The category decides what a
human does next, so choosing between them is the entire task.

product-bug     The system under test is wrong. The fix is in the product code.
test-bug        The test or its assertion is wrong. The product is fine.
test-equipment  The harness, generator, fixture or handler is wrong, so the
                suite is not exercising what it claims to exercise. This often
                looks like a PASS, or like a suite that finished suspiciously
                fast, or like a mutation that should have been caught and was
                not. Distinguish it from test-bug: a test-bug fails loudly, and
                broken equipment passes quietly.
environment     Neither the product nor the test is wrong. Infrastructure,
                configuration, timing or resource contention caused it.
equivalent      A mutation that cannot change observable behaviour, so no test
                could ever catch it. No action is warranted.

Give a one-sentence root cause naming the specific mechanism, not a restatement
of the symptom. Give a confidence between 0 and 1.`

interface Verdict {
  readonly id: string
  readonly label: FailureLabel
  readonly rootCause: string
  readonly confidence: number
}

/**
 * A strict tool is the structured-output mechanism here: the model must return
 * arguments that validate against the schema, so a malformed label is a 400
 * rather than a parsing problem downstream.
 */
const TRIAGE_TOOL = {
  name: 'record_triage',
  description: 'Record the classification for one failure.',
  strict: true,
  input_schema: {
    type: 'object' as const,
    additionalProperties: false,
    required: ['label', 'root_cause', 'confidence'],
    properties: {
      label: { type: 'string', enum: [...LABELS] },
      root_cause: { type: 'string' },
      confidence: { type: 'number' },
    },
  },
}

function prompt(failure: LabelledFailure): string {
  return `Failure id: ${failure.id}\n\nEvidence:\n${failure.evidence}`
}

async function classify(
  client: ReturnType<typeof createClient>,
  model: string,
  tracker: SpendTracker,
  failure: LabelledFailure,
): Promise<Verdict> {
  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    system: SYSTEM,
    tools: [TRIAGE_TOOL],
    // Forced, not merely offered. Left to choose, a model sometimes answers in
    // prose, and a triage step that fails on one input in twelve because the
    // answer arrived in the wrong shape is not a triage step. Forcing the tool
    // also means the schema is enforced server-side.
    tool_choice: { type: 'tool', name: TRIAGE_TOOL.name },
    messages: [{ role: 'user', content: prompt(failure) }],
  })
  tracker.record(model, response.usage)

  const call = response.content.find((block) => block.type === 'tool_use')
  if (call === undefined || call.type !== 'tool_use') {
    throw new Error(`${failure.id}: model returned no classification`)
  }
  const input = call.input as { label: FailureLabel; root_cause: string; confidence: number }
  return {
    id: failure.id,
    label: input.label,
    rootCause: input.root_cause,
    confidence: input.confidence,
  }
}

// --------------------------------------------------------------------- main

const modelFlag = process.argv.indexOf('--model')
const model = modelFlag === -1 ? MODELS.classifier : (process.argv[modelFlag + 1] ?? MODELS.classifier)

const client = createClient()

// Estimate before spending, from the API's own token count rather than a guess.
const sampleTokens = await countInputTokens(client, model, SYSTEM, prompt(FAILURE_CORPUS[0]!))
const estimate = estimateCost(model, sampleTokens * FAILURE_CORPUS.length, 200 * FAILURE_CORPUS.length)
console.log(`model: ${model}`)
console.log(`corpus: ${FAILURE_CORPUS.length} failures`)
console.log(`estimated cost: $${estimate.toFixed(4)} (limit $${MAX_SPEND_USD.toFixed(2)})\n`)

const tracker = new SpendTracker()
const verdicts: Verdict[] = []
for (const failure of FAILURE_CORPUS) {
  verdicts.push(await classify(client, model, tracker, failure))
}

// ------------------------------------------------------------------ scoring

const correct = verdicts.filter((v) => v.label === corpusLabel(v.id)).length
const accuracy = correct / verdicts.length

function corpusLabel(id: string): FailureLabel {
  return FAILURE_CORPUS.find((f) => f.id === id)!.label
}

console.log(`accuracy: ${correct}/${verdicts.length} = ${(accuracy * 100).toFixed(1)}%\n`)

console.log('per label:')
for (const label of LABELS) {
  const actual = FAILURE_CORPUS.filter((f) => f.label === label)
  const predicted = verdicts.filter((v) => v.label === label)
  const truePositives = verdicts.filter((v) => v.label === label && corpusLabel(v.id) === label)
  const precision = predicted.length === 0 ? null : truePositives.length / predicted.length
  const recall = actual.length === 0 ? null : truePositives.length / actual.length
  const fmt = (n: number | null): string => (n === null ? '  n/a' : `${(n * 100).toFixed(0)}%`.padStart(5))
  console.log(
    `  ${label.padEnd(16)} actual ${String(actual.length).padStart(2)}  ` +
      `predicted ${String(predicted.length).padStart(2)}  ` +
      `precision ${fmt(precision)}  recall ${fmt(recall)}`,
  )
}

const misses = verdicts.filter((v) => v.label !== corpusLabel(v.id))
if (misses.length > 0) {
  console.log('\nmisclassified:')
  for (const miss of misses) {
    console.log(`  ${miss.id}`)
    console.log(`    labelled  ${corpusLabel(miss.id)}`)
    console.log(`    predicted ${miss.label} (confidence ${miss.confidence.toFixed(2)})`)
    console.log(`    its reasoning: ${miss.rootCause}`)
  }
}

// Confidence is only useful if it correlates with being right. If the model is
// equally confident when wrong, the number is decoration and should be ignored.
const avg = (list: Verdict[]): number =>
  list.length === 0 ? 0 : list.reduce((s, v) => s + v.confidence, 0) / list.length
const hits = verdicts.filter((v) => v.label === corpusLabel(v.id))
console.log(
  `\nmean confidence when right: ${avg(hits).toFixed(2)}, when wrong: ${avg(misses).toFixed(2)}`,
)

console.log(`\n${tracker.summary()}`)

// One file per model, so running the second model does not overwrite the first.
const output = `qe/ai/results/triage-${model.replace(/^claude-/, '')}.json`
mkdirSync('qe/ai/results', { recursive: true })
writeFileSync(
  output,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      model,
      corpusSize: FAILURE_CORPUS.length,
      correct,
      accuracy,
      estimatedSpendUsd: Number(tracker.spent.toFixed(6)),
      verdicts: verdicts.map((v) => ({ ...v, labelled: corpusLabel(v.id) })),
    },
    null,
    2,
  )}\n`,
)
console.log(`written to ${output}`)
