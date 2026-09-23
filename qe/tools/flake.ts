/**
 * Flake detection.
 *
 * Runs the pull-request suite N times and reports anything that is not
 * unanimous. A test that passes nine times and fails once is not a test, it is
 * a coin toss with a good bias, and it is worse than no test because people
 * learn to re-run it and then learn to ignore it.
 *
 * There is no quarantine. Quarantine sounds like a compromise and works as a
 * graveyard: a test nobody trusts still costs a run and still costs attention.
 * Anything this reports gets fixed or deleted within a working day. See
 * docs/CI-POLICY.md.
 *
 *   npm run flake:detect
 *   npm run flake:detect -- --runs 20
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

const runsFlag = process.argv.indexOf('--runs')
const RUNS = Number(runsFlag === -1 ? (process.env.FLAKE_RUNS ?? 10) : process.argv[runsFlag + 1])

/** Per-test pass and fail counts across every run. */
const results = new Map<string, { passed: number; failed: number }>()
const runFailures: string[][] = []

function record(name: string, passed: boolean): void {
  const entry = results.get(name) ?? { passed: 0, failed: 0 }
  if (passed) entry.passed++
  else entry.failed++
  results.set(name, entry)
}

for (let run = 1; run <= RUNS; run++) {
  process.stdout.write(`run ${run}/${RUNS} `)
  let output = ''
  try {
    output = execFileSync('npx', ['vitest', 'run', '--reporter=json', '--outputFile=-'], {
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 15 * 60_000,
      killSignal: 'SIGKILL',
    })
  } catch (error) {
    const e = error as { stdout?: string }
    output = e.stdout ?? ''
  }

  // The JSON reporter prints a single object; anything before it is noise.
  const start = output.indexOf('{')
  if (start === -1) {
    console.log('- could not parse reporter output; counting as a failed run')
    runFailures.push(['<unparseable run>'])
    continue
  }

  const report = JSON.parse(output.slice(start)) as {
    testResults: { name: string; assertionResults: { fullName: string; status: string }[] }[]
  }

  const failedThisRun: string[] = []
  for (const file of report.testResults) {
    for (const assertion of file.assertionResults) {
      const name = `${file.name.replace(`${process.cwd()}/`, '')} > ${assertion.fullName}`
      const passed = assertion.status === 'passed'
      record(name, passed)
      if (!passed) failedThisRun.push(name)
    }
  }
  runFailures.push(failedThisRun)
  console.log(`- ${failedThisRun.length} failed`)
}

const flaky = [...results.entries()]
  .filter(([, counts]) => counts.passed > 0 && counts.failed > 0)
  .sort((a, b) => b[1].failed - a[1].failed)

const alwaysFailing = [...results.entries()].filter(([, c]) => c.passed === 0 && c.failed > 0)

console.log(`\n${results.size} tests over ${RUNS} runs`)

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

mkdirSync('qe/mutation/reports', { recursive: true })
writeFileSync(
  'qe/mutation/reports/flake.json',
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      runs: RUNS,
      testCount: results.size,
      flaky: flaky.map(([name, counts]) => ({ name, ...counts })),
      alwaysFailing: alwaysFailing.map(([name]) => name),
    },
    null,
    2,
  )}\n`,
)

// A flaky test fails the job. It is a defect in the suite, and a job that
// reports flakiness without failing is a job people stop reading.
process.exit(flaky.length > 0 ? 1 : 0)
