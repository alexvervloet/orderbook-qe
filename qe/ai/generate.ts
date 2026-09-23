/**
 * Track A: AI test generation, scored by mutation kill rate.
 *
 * The model is given the written specification and the module's public surface,
 * and asked for a test suite. What comes back is then held to the same standard
 * as anything a person writes here:
 *
 *   1. Does it compile and pass against the correct implementation? A test that
 *      fails on correct code is wrong, and is discarded rather than "fixed",
 *      because fixing it means writing it myself and claiming the model did.
 *   2. What share of mutants does it kill, running alone?
 *   3. How does that compare with the hand-written suite on the same mutants?
 *
 * Step 3 is the only interesting number. Generated tests always look
 * convincing; assertions that restate the implementation look exactly like
 * assertions that check a requirement, and only a mutant can tell them apart.
 *
 *   ANTHROPIC_API_KEY=... AI_MAX_SPEND_USD=1 npm run ai:generate
 *   ANTHROPIC_API_KEY=... AI_MAX_SPEND_USD=1 npm run ai:generate -- --target ledger
 *
 * The spend guard checks each call's worst case before sending it, and one
 * call with this output budget can cost more than the default $0.25 limit, so
 * the limit has to be raised on purpose to run this at all.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import {
  countInputTokens,
  createClient,
  estimateCost,
  MAX_SPEND_USD,
  MODELS,
  SpendTracker,
} from './client.ts'
import { findMutants } from '../mutation/mutators.ts'
import { isKnownEquivalent } from '../mutation/equivalents.ts'

interface Target {
  readonly name: string
  /** The module being tested. */
  readonly source: string
  /** The written requirements. Given to the model instead of the tests. */
  readonly spec: string
  /** Where the generated suite is written. */
  readonly output: string
  /**
   * The hand-written suites that guard this module, for the comparison. They
   * must be runnable test files or directories: book-side once pointed at
   * conformance.ts, which is a module rather than a test file, so vitest found
   * nothing, exited non-zero for every mutant, and scored the hand-written side
   * at 100%.
   */
  readonly handWritten: readonly string[]
}

const TARGETS: readonly Target[] = [
  {
    name: 'ledger',
    source: 'sut/backend/ledger.ts',
    spec: 'spec/LEDGER.md',
    output: 'qe/ai/generated/ledger.generated.test.ts',
    handWritten: ['qe/suites/property/ledger.test.ts'],
  },
  {
    name: 'book-side',
    source: 'sut/backend/engine/book-side.ts',
    spec: 'spec/SEMANTICS.md',
    output: 'qe/ai/generated/book-side.generated.test.ts',
    // What the mutation runner itself uses for this target.
    handWritten: ['qe/suites/unit', 'qe/suites/property'],
  },
]

/**
 * Thinking and text share this budget. At 16000 the file came back cut off
 * mid-literal, and a truncated file looks exactly like a badly written one
 * three steps later.
 */
const MAX_OUTPUT_TOKENS = 32_000

const SYSTEM = `You write tests for an onchain exchange. You are given a written
specification and the module that is supposed to implement it.

Write a Vitest suite in TypeScript. Rules that matter here:

- Assert what the specification requires, never what the implementation
  happens to do. If the two disagree, follow the specification.
- Every numeric quantity is a bigint. There is no floating point.
- Import with explicit .ts extensions; this project runs TypeScript directly.
- Cover boundaries: zero, one, the exact threshold, one past it, and values
  above 2^53 where a JavaScript number would lose precision.
- Do not write a test whose expected value you obtained by reasoning about the
  code rather than the specification. Such a test passes no matter what the
  code does, which is worse than no test.

Return only the file contents. No prose, no markdown fence.`

function buildPrompt(target: Target): string {
  return [
    `# Specification: ${target.spec}`,
    '',
    readFileSync(target.spec, 'utf8'),
    '',
    `# Module under test: ${target.source}`,
    '',
    readFileSync(target.source, 'utf8'),
    '',
    '# Task',
    '',
    `Write a Vitest suite at ${target.output} testing ${target.source}.`,
    `Import it as '${relativeImport(target.output, target.source)}'.`,
  ].join('\n')
}

function relativeImport(from: string, to: string): string {
  const depth = from.split('/').length - 1
  return `${'../'.repeat(depth)}${to}`
}

/**
 * Strip a markdown fence, tolerating a missing closing fence.
 *
 * The strict "fence at both ends" version silently passed truncated output
 * through as though it were a file, and the failure surfaced three steps later
 * as a syntax error. Be liberal here and detect truncation explicitly instead.
 */
function stripFence(text: string): string {
  let body = text.trim()
  const opening = /^```[a-zA-Z]*\n/.exec(body)
  if (opening !== null) body = body.slice(opening[0].length)
  const closing = /\n```\s*$/.exec(body)
  if (closing !== null) body = body.slice(0, closing.index)
  return body.trim()
}

/** Generated suites live outside the default config, so they carry their own. */
function vitestArgs(suites: readonly string[]): string[] {
  const config = suites.some((s) => s.startsWith('qe/ai/generated/'))
    ? ['--config', 'vitest.generated.config.ts']
    : []
  return ['vitest', 'run', ...config, ...suites]
}

function run(command: string, args: readonly string[]): { ok: boolean; output: string } {
  try {
    const output = execFileSync(command, args, { stdio: 'pipe', encoding: 'utf8' })
    return { ok: true, output }
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string }
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

/** Kill rate of some suites against every mutant of one source file. */
function mutationScore(
  sourceFile: string,
  suites: readonly string[],
): { killed: number; scored: number; survivors: string[] } {
  const original = readFileSync(sourceFile, 'utf8')
  // A suite that fails on correct code "kills" every mutant. Refuse to score it.
  const baseline = run('npx', vitestArgs(suites))
  if (!baseline.ok) {
    throw new Error(
      `${suites.join(' ')} does not pass on the unmutated ${sourceFile}, so a kill rate ` +
        `would mean nothing:\n${baseline.output.slice(0, 2000)}`,
    )
  }
  const sites = findMutants(sourceFile, original).filter((s) => !isKnownEquivalent(s))
  const survivors: string[] = []
  let killed = 0

  try {
    for (const site of sites) {
      writeFileSync(sourceFile, site.mutated)
      const result = run('npx', vitestArgs(suites))
      if (result.ok) survivors.push(`${site.file}:${site.line} ${site.mutator.description}`)
      else killed++
    }
  } finally {
    writeFileSync(sourceFile, original)
  }
  return { killed, scored: sites.length, survivors }
}

// --------------------------------------------------------------------- main

const targetFlag = process.argv.indexOf('--target')
const only = targetFlag === -1 ? undefined : process.argv[targetFlag + 1]
const targets = only === undefined ? TARGETS : TARGETS.filter((t) => t.name === only)

const client = createClient()
const tracker = new SpendTracker()
mkdirSync('qe/ai/generated', { recursive: true })

const results: unknown[] = []

for (const target of targets) {
  console.log(`\n=== ${target.name} ===`)
  const userPrompt = buildPrompt(target)

  const inputTokens = await countInputTokens(client, MODELS.author, SYSTEM, userPrompt)
  const estimate = estimateCost(MODELS.author, inputTokens, 20000)
  console.log(`input tokens: ${inputTokens}, estimated cost: $${estimate.toFixed(4)} (limit $${MAX_SPEND_USD.toFixed(2)})`)
  tracker.ensureRoom(MODELS.author, inputTokens, MAX_OUTPUT_TOKENS)

  // Streamed because a whole test file is a long output and a non-streaming
  // request with a large max_tokens risks an HTTP timeout.
  const stream = client.messages.stream({
    model: MODELS.author,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: SYSTEM,
    thinking: { type: 'adaptive' },
    // A whole test file does not need maximum deliberation, and effort is
    // charged in output tokens like everything else.
    output_config: { effort: 'medium' },
    messages: [{ role: 'user', content: userPrompt }],
  })
  const message = await stream.finalMessage()
  tracker.record(MODELS.author, message.usage)

  if (message.stop_reason === 'max_tokens') {
    // It used to say this and then carry on scoring the truncated file.
    console.log('  output hit max_tokens and is truncated. Recording a failed run.')
    results.push({ target: target.name, truncated: true })
    continue
  }

  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
  writeFileSync(target.output, `${stripFence(text)}\n`)
  console.log(`written: ${target.output}`)

  // Gate 1: does it compile?
  //
  // One repair round is allowed here, with the compiler's own error fed back,
  // and one more below for tests that fail on correct code. That
  // is the workflow a person actually uses, and refusing it would measure
  // one-shot output rather than the thing being evaluated. What is not allowed
  // is me editing the file: the count of repair rounds is reported instead.
  let typecheck = run('npx', ['tsc', '--noEmit'])
  let repairRounds = 0
  if (!typecheck.ok) {
    const errors = typecheck.output
      .split('\n')
      .filter((line) => line.includes(target.output))
      .join('\n')
    console.log(`typecheck failed, sending the compiler error back:\n  ${errors.split('\n')[0]}`)
    // The previous output goes back in as input, so the worst case grows.
    tracker.ensureRoom(MODELS.author, inputTokens + MAX_OUTPUT_TOKENS + 2_000, MAX_OUTPUT_TOKENS)

    const repair = client.messages.stream({
      model: MODELS.author,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: SYSTEM,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      messages: [
        { role: 'user', content: userPrompt },
        { role: 'assistant', content: readFileSync(target.output, 'utf8') },
        {
          role: 'user',
          content:
            `tsc rejected that file. This project sets exactOptionalPropertyTypes ` +
            `and noUncheckedIndexedAccess, which are stricter than most.\n\n` +
            `${errors}\n\nReturn the corrected file in full. Do not weaken any assertion ` +
            `to make the compiler happy; fix the types.`,
        },
      ],
    })
    const repaired = await repair.finalMessage()
    tracker.record(MODELS.author, repaired.usage)
    repairRounds = 1

    const repairedText = repaired.content
      .filter((block) => block.type === 'text')
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('')
    writeFileSync(target.output, `${stripFence(repairedText)}\n`)
    typecheck = run('npx', ['tsc', '--noEmit'])
  }
  console.log(`typechecks: ${typecheck.ok ? 'yes' : 'no'} (repair rounds: ${repairRounds})`)

  // Gate 2: does it pass against correct code?
  const passes = run('npx', vitestArgs([target.output]))
  const countMatch = /Tests\s+(?:(\d+) failed \| )?(\d+) passed/.exec(passes.output)
  let failed = Number(countMatch?.[1] ?? 0)
  let passed = Number(countMatch?.[2] ?? 0)
  const oneShotPassed = passed
  const oneShotFailed = failed
  console.log(`against correct code: ${passed} passed, ${failed} failed`)
  // A second repair round, for tests that fail against correct code.
  //
  // Same principle as the typecheck round: the model gets its own failure
  // output back, which is what a person does. I do not edit the file, because
  // that would make this a measurement of my editing.
  if (failed > 0) {
    console.log('  sending the test failures back for one repair round')
    tracker.ensureRoom(MODELS.author, inputTokens + MAX_OUTPUT_TOKENS + 4_000, MAX_OUTPUT_TOKENS)
    const repair = client.messages.stream({
      model: MODELS.author,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: SYSTEM,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      messages: [
        { role: 'user', content: userPrompt },
        { role: 'assistant', content: readFileSync(target.output, 'utf8') },
        {
          role: 'user',
          content:
            `${failed} of those tests fail against the correct implementation, so ` +
            `those tests are wrong. Read the failures carefully and check the ` +
            `argument order and units of the functions you are calling.\n\n` +
            `${passes.output.slice(0, 6000)}\n\n` +
            `Return the corrected file in full. Do not weaken or delete a test to ` +
            `make it pass; work out what the specification actually requires.`,
        },
      ],
    })
    const repaired = await repair.finalMessage()
    tracker.record(MODELS.author, repaired.usage)
    repairRounds += 1

    const repairedText = repaired.content
      .filter((block) => block.type === 'text')
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('')
    writeFileSync(target.output, `${stripFence(repairedText)}\n`)

    const retry = run('npx', vitestArgs([target.output]))
    const retryMatch = /Tests\s+(?:(\d+) failed \| )?(\d+) passed/.exec(retry.output)
    failed = Number(retryMatch?.[1] ?? 0)
    passed = Number(retryMatch?.[2] ?? 0)
    console.log(`  after repair: ${passed} passed, ${failed} failed`)
  }

  // Gate 3: the only number that matters.
  let generated = { killed: 0, scored: 0, survivors: [] as string[] }
  let handWritten = { killed: 0, scored: 0, survivors: [] as string[] }
  if (typecheck.ok && failed === 0 && passed > 0) {
    console.log('scoring generated suite against mutants...')
    generated = mutationScore(target.source, [target.output])
    console.log('scoring hand-written suite against the same mutants...')
    handWritten = mutationScore(target.source, target.handWritten)

    const pct = (k: number, s: number): string => (s === 0 ? 'n/a' : `${((k / s) * 100).toFixed(1)}%`)
    console.log(`\n  generated:    ${generated.killed}/${generated.scored} = ${pct(generated.killed, generated.scored)}`)
    console.log(`  hand-written: ${handWritten.killed}/${handWritten.scored} = ${pct(handWritten.killed, handWritten.scored)}`)
  } else {
    console.log('skipping mutation scoring: the generated suite did not clear the earlier gates.')
  }

  results.push({
    target: target.name,
    typechecks: typecheck.ok,
    repairRounds,
    oneShotPassed,
    oneShotFailed,
    passedAgainstCorrectCode: passed,
    failedAgainstCorrectCode: failed,
    generated,
    handWritten,
  })
}

console.log(`\n${tracker.summary()}`)
mkdirSync('qe/ai/results', { recursive: true })
writeFileSync(
  'qe/ai/results/generation.json',
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      model: MODELS.author,
      estimatedSpendUsd: Number(tracker.spent.toFixed(6)),
      results,
    },
    null,
    2,
  )}\n`,
)
console.log('written to qe/ai/results/generation.json')
