/**
 * Flake detection.
 *
 * Runs the pull-request suites N times and reports anything that is not
 * unanimous. A test that passes nine times and fails once is not a test, it is
 * a coin toss with a good bias, and it is worse than no test because people
 * learn to re-run it and then learn to ignore it.
 *
 * Both runners are covered, and every forge run gets its own fuzz seed. The
 * fuzz seed is exactly where a flaky assertion hides: the invariant suite once
 * failed one run in four, and a vitest-only flake job could never have seen it.
 *
 * There is no quarantine. Quarantine sounds like a compromise and works as a
 * graveyard: a test nobody trusts still costs a run and still costs attention.
 * Anything this reports gets fixed or deleted within a working day. See
 * docs/CI-POLICY.md.
 *
 *   npm run flake:detect
 *   npm run flake:detect -- --runs 20
 *   npm run flake:detect -- --only vitest
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const flag = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}
const RUNS = Number(flag('--runs') ?? process.env.FLAKE_RUNS ?? 10)
const ONLY = flag('--only')
const REPORTS = 'qe/mutation/reports'
const CONTRACTS = 'sut/contracts'
const FORGE = process.env.FORGE_BIN ?? (existsSync(join(homedir(), '.foundry/bin/forge')) ? join(homedir(), '.foundry/bin/forge') : 'forge')

/** Per-test pass and fail counts across every run. Skipped tests are not recorded. */
const results = new Map<string, { passed: number; failed: number }>()
/** Runs that produced no usable report. Any at all fails the job. */
const brokenRuns: string[] = []
/** Fuzz seed per forge run, so a flaky result can be replayed with --fuzz-seed. */
const seeds: string[] = []

function record(name: string, passed: boolean): void {
  const entry = results.get(name) ?? { passed: 0, failed: 0 }
  if (passed) entry.passed++
  else entry.failed++
  results.set(name, entry)
}

/** Run a command, tolerating a non-zero exit: a failing test is data here. */
function run(command: string, args: string[], cwd = '.'): string {
  try {
    return execFileSync(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 15 * 60_000,
      killSignal: 'SIGKILL',
      maxBuffer: 256 * 1024 * 1024,
    })
  } catch (error) {
    return (error as { stdout?: string }).stdout ?? ''
  }
}

/**
 * One vitest run. The JSON reporter writes to a file, not stdout: an earlier
 * version passed `--outputFile=-`, which vitest took as a file literally named
 * "-", so every run was unparseable and the tool reported "no flaky tests"
 * having read nothing.
 */
function vitestRun(label: string): number | null {
  const file = join(REPORTS, 'flake-vitest-run.json')
  rmSync(file, { force: true })
  run('npx', ['vitest', 'run', '--reporter=json', `--outputFile=${file}`])
  if (!existsSync(file)) {
    brokenRuns.push(`${label}: vitest wrote no report`)
    return null
  }
  const report = JSON.parse(readFileSync(file, 'utf8')) as {
    testResults: { name: string; assertionResults: { fullName: string; status: string }[] }[]
  }
  let failed = 0
  for (const suite of report.testResults) {
    for (const assertion of suite.assertionResults) {
      if (assertion.status !== 'passed' && assertion.status !== 'failed') continue
      const name = `${suite.name.replace(`${process.cwd()}/`, '')} > ${assertion.fullName}`
      record(name, assertion.status === 'passed')
      if (assertion.status === 'failed') failed++
    }
  }
  return failed
}

/** One forge run, with any persisted invariant failure cleared first. */
function forgeRun(label: string): number | null {
  // Foundry replays a persisted failing sequence before anything else, which
  // would turn one flaky failure into a unanimous one.
  rmSync(join(CONTRACTS, 'cache/invariant'), { recursive: true, force: true })
  // An explicit seed per run. Left to itself, `forge test --json` reused the
  // same seed every time here, so ten runs were one run ten times and a check
  // that failed one plain run in four never failed at all.
  const seed = `0x${randomBytes(32).toString('hex')}`
  seeds.push(`${label}: ${seed}`)
  const output = run(FORGE, ['test', '--json', '--fuzz-seed', seed], CONTRACTS)
  const start = output.indexOf('{')
  if (start === -1) {
    brokenRuns.push(`${label}: forge produced no JSON`)
    return null
  }
  const report = JSON.parse(output.slice(start)) as Record<
    string,
    { test_results: Record<string, { status: string }> }
  >
  let failed = 0
  for (const [suite, { test_results }] of Object.entries(report)) {
    for (const [test, { status }] of Object.entries(test_results)) {
      if (status === 'Skipped') continue
      record(`${suite} > ${test}`, status === 'Success')
      if (status !== 'Success') failed++
    }
  }
  return failed
}

const runners = [
  ['vitest', vitestRun],
  ['forge', forgeRun],
] as const

mkdirSync(REPORTS, { recursive: true })
for (const [name, once] of runners) {
  if (ONLY !== undefined && ONLY !== name) continue
  for (let i = 1; i <= RUNS; i++) {
    process.stdout.write(`${name} run ${i}/${RUNS} `)
    const failed = once(`${name} run ${i}`)
    console.log(failed === null ? '- no report' : `- ${failed} failed`)
  }
}
rmSync(join(REPORTS, 'flake-vitest-run.json'), { force: true })

const flaky = [...results.entries()]
  .filter(([, counts]) => counts.passed > 0 && counts.failed > 0)
  .sort((a, b) => b[1].failed - a[1].failed)

const alwaysFailing = [...results.entries()].filter(([, c]) => c.passed === 0 && c.failed > 0)

console.log(`\n${results.size} tests over ${RUNS} runs each`)

if (brokenRuns.length > 0) {
  // A run that produced nothing proves nothing. Reporting "no flaky tests"
  // after reading no results is how this tool used to lie.
  console.log(`\n${brokenRuns.length} run(s) produced no usable report:`)
  for (const run of brokenRuns) console.log(`  ${run}`)
}

if (alwaysFailing.length > 0) {
  // Not flaky. Broken. Reported separately so the two are never confused.
  console.log(`\n${alwaysFailing.length} test(s) failed every run. These are broken, not flaky:`)
  for (const [name] of alwaysFailing) console.log(`  ${name}`)
}

if (flaky.length === 0) {
  console.log('\nno flaky tests: every test was unanimous across all runs')
} else {
  console.log(`\n${flaky.length} flaky test(s). Fix or delete within one working day:`)
  for (const [name, counts] of flaky) {
    const rate = ((counts.failed / (counts.passed + counts.failed)) * 100).toFixed(0)
    console.log(`  ${rate.padStart(3)}% failure  ${name}`)
  }
}

writeFileSync(
  join(REPORTS, 'flake.json'),
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      runs: RUNS,
      testCount: results.size,
      brokenRuns,
      forgeSeeds: seeds,
      flaky: flaky.map(([name, counts]) => ({ name, ...counts })),
      alwaysFailing: alwaysFailing.map(([name]) => name),
    },
    null,
    2,
  )}\n`,
)

// Flaky, broken, or unreadable all fail the job. A job that reports a problem
// without failing is a job people stop reading.
const clean = flaky.length === 0 && alwaysFailing.length === 0 && brokenRuns.length === 0
process.exit(clean && results.size > 0 ? 0 : 1)
