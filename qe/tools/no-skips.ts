/**
 * Fail the build if any test was skipped.
 *
 * A suite that silently shrinks is the worst kind of regression, because the
 * build stays green while the coverage leaves. `.skip` added to get a branch
 * merged is nearly always permanent, so it has to be a deliberate act with a
 * paper trail rather than a one-character edit nobody sees in review.
 *
 * This reads what vitest actually ran, not the source text. The first version
 * grepped for `.skip` and so missed `it.skipIf`, `ctx.skip()` and any skip
 * decided at runtime, while failing the build on a comment that mentioned
 * `describe.skip`. The question is whether a test ran, and only the runner
 * knows that.
 *
 * Skipping is still allowed. It has to be declared here, with a reason and the
 * issue that will remove it.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'

interface AllowedSkip {
  readonly file: string
  readonly reason: string
  readonly issue: string
}

/**
 * Every file allowed to skip tests, with the reason.
 *
 * Adding to this list is a decision someone has to defend, which is the point:
 * the cost of skipping should be a paragraph of justification, not one
 * character.
 */
const ALLOWED: readonly AllowedSkip[] = [
  {
    file: 'qe/suites/chaos/network.test.ts',
    reason:
      'Fault injection needs Toxiproxy, which only exists under the chaos ' +
      'compose profile. The suite skips when it is unreachable rather than ' +
      'failing, because a developer running `npm test` has not done anything ' +
      'wrong. The nightly chaos job starts the profile and sets ' +
      'REQUIRE_TOXIPROXY=1, under which an unreachable proxy fails instead.',
    issue: 'n/a, permanent by design',
  },
]

const REPORT = 'qe/mutation/reports/no-skips.json'
mkdirSync('qe/mutation/reports', { recursive: true })
rmSync(REPORT, { force: true })

try {
  execFileSync('npx', ['vitest', 'run', '--reporter=json', `--outputFile=${REPORT}`], {
    stdio: ['ignore', 'ignore', 'inherit'],
  })
} catch {
  // Failing tests are the test step's business. This step is about skips, and
  // a failed run still reports which tests it skipped.
}

if (!existsSync(REPORT)) {
  console.error('vitest wrote no report, so nothing can be said about skips')
  process.exit(1)
}

const report = JSON.parse(readFileSync(REPORT, 'utf8')) as {
  numTotalTests: number
  testResults: { name: string; assertionResults: { fullName: string; status: string }[] }[]
}

const skipped: { file: string; test: string; status: string }[] = []
for (const suite of report.testResults) {
  const file = suite.name.replace(`${process.cwd()}/`, '')
  for (const assertion of suite.assertionResults) {
    if (assertion.status === 'passed' || assertion.status === 'failed') continue
    skipped.push({ file, test: assertion.fullName, status: assertion.status })
  }
}

const offenders = skipped.filter((s) => !ALLOWED.some((a) => a.file === s.file))
const allowed = skipped.length - offenders.length

if (offenders.length > 0) {
  console.error('Skipped tests are not allowed without an entry in ALLOWED:\n')
  for (const o of offenders) console.error(`  ${o.status.padEnd(8)} ${o.file} > ${o.test}`)
  console.error('\nAdd the file to qe/tools/no-skips.ts with a reason and an issue, or remove the skip.')
  process.exit(1)
}

console.log(
  `${report.numTotalTests} tests, none skipped` +
    (allowed > 0 ? ` outside the allowed list (${allowed} allowed skip(s))` : ''),
)
