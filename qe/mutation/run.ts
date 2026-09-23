/**
 * Mutation runner.
 *
 * For each target file, generate every mutant, apply it, run the suite that is
 * supposed to catch it, and record whether the suite went red. The result is a
 * kill rate: the share of deliberate defects the tests actually notice.
 *
 * Coverage says which lines ran. This says which lines were checked, and the
 * difference on this repository was two real bugs.
 *
 * Nothing here gates a merge. See docs/NON-GOALS.md for why.
 *
 *   npm run mutate                       everything
 *   npm run mutate -- --target engine    one target
 *   npm run mutate -- --limit 20         a sample, for a quick read
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { findMutants, type MutantSite } from './mutators.ts'
import { EQUIVALENT_MUTANTS, isKnownEquivalent } from './equivalents.ts'

interface Target {
  readonly name: string
  readonly file: string
  /** The command that should fail when this file is broken. */
  readonly command: readonly string[]
  readonly cwd: string
}

const TARGETS: readonly Target[] = [
  {
    name: 'engine',
    file: 'sut/backend/engine/matching-engine.ts',
    command: ['npx', 'vitest', 'run', 'qe/suites/unit', 'qe/suites/property'],
    cwd: '.',
  },
  {
    name: 'book-side',
    file: 'sut/backend/engine/book-side.ts',
    command: ['npx', 'vitest', 'run', 'qe/suites/unit', 'qe/suites/property'],
    cwd: '.',
  },
  {
    name: 'ledger',
    file: 'sut/backend/ledger.ts',
    command: ['npx', 'vitest', 'run', 'qe/suites/property'],
    cwd: '.',
  },
  {
    name: 'reference',
    file: 'qe/model/reference-engine.ts',
    command: ['npx', 'vitest', 'run', 'qe/suites/unit', 'qe/suites/property'],
    cwd: '.',
  },
  {
    name: 'contract',
    file: 'sut/contracts/src/OrderBookExchange.sol',
    command: ['forge', 'test'],
    cwd: 'sut/contracts',
  },
]

interface Outcome {
  readonly site: MutantSite
  readonly status: 'killed' | 'survived' | 'equivalent' | 'timeout'
}

/**
 * Per-mutant wall-clock limit.
 *
 * A mutant can turn a loop into an infinite one. `if (ready.length === 0) break`
 * becoming `!== 0` did exactly that in the stop-trigger cascade: the loop never
 * terminates, the test runner pins a core, and a synchronous exec waits for it
 * forever. The first full run sat there for fifty minutes with a mutant written
 * into the working tree. See LESSONS.md.
 *
 * A mutant that hangs is a killed mutant: the tests would have caught it, by
 * never finishing. What it must not do is take the harness down with it.
 */
const MUTANT_TIMEOUT_MS = Number(process.env.MUTATION_TIMEOUT_MS ?? 60_000)

/**
 * A mutation run rewrites files in place, so two of them at once corrupt each
 * other's restore. The lock makes that a clear error rather than a mystery.
 */
const LOCK = 'qe/mutation/.running.lock'

function acquireLock(): void {
  if (existsSync(LOCK)) {
    throw new Error(
      `${LOCK} exists, so another mutation run may be in progress. ` +
        'Two runs rewrite the same files and will corrupt each other. ' +
        `If no run is active, delete ${LOCK} and check "git status" for a ` +
        'source file left mutated.',
    )
  }
  writeFileSync(LOCK, `${process.pid}\n`)
}

function releaseLock(): void {
  if (existsSync(LOCK)) rmSync(LOCK)
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}

/**
 * Kill anything this harness started that outlived it.
 *
 * `execFileSync`'s timeout kills the child the harness is waiting on. It does
 * nothing for grandchildren, and nothing at all if the harness itself is killed
 * from outside: the test runner's worker processes are then orphaned, and a
 * worker stuck in a mutant's infinite loop spins a core until someone notices.
 *
 * Twenty of them accumulated over one session, at eleven cores between them,
 * before anyone did. See LESSONS.md.
 */
function reapOrphanedWorkers(): void {
  // Matched narrowly: this repository's test-runner workers and nothing else.
  spawnSync('pkill', ['-9', '-f', 'vitest/dist/workers'], { stdio: 'ignore' })
}

/**
 * Recompile a restored Solidity target.
 *
 * Restoring the source is not enough for a language that produces build
 * artifacts. `forge test` leaves the last mutant's bytecode in `out/`, and
 * every consumer of that directory then deploys a mutated contract with a clean
 * `git status` to reassure them. The offchain/onchain suites failed for an hour
 * this way, and the symptom looked like a fixture problem two directories away.
 *
 * TypeScript targets need nothing here because nothing compiles them ahead of
 * time. That asymmetry is exactly why it was easy to miss.
 */
function rebuildIfCompiled(target: Target): void {
  if (!target.file.endsWith('.sol')) return
  try {
    execFileSync('forge', ['build'], {
      cwd: target.cwd,
      stdio: 'pipe',
      timeout: 120_000,
      env: { ...process.env, PATH: `${process.env.HOME}/.foundry/bin:${process.env.PATH ?? ''}` },
    })
  } catch {
    console.error(
      '\nWARNING: could not rebuild contracts after restoring the source. ' +
        'Run `forge build --force` in sut/contracts before trusting any onchain test.',
    )
  }
}

/** The runner could not run the suite at all. Never a kill. */
class HarnessError extends Error {}

/**
 * Set by SIGINT or SIGTERM. Checked between mutants.
 *
 * The handler cannot act directly. The loop used to be entirely synchronous, so
 * Node never got back to its event loop to deliver the signal: a SIGTERM to the
 * runner was ignored until every mutant had run. Ctrl-C at a terminal reached
 * the vitest child as well, which died, and that death was scored as a kill
 * before the loop moved on to the next mutant.
 */
let interrupted: NodeJS.Signals | null = null

/** The file currently holding a mutant, so any exit path can put it back. */
let pendingRestore: { file: string; original: string } | null = null

type SuiteResult = 'killed' | 'survived' | 'timeout' | 'interrupted'

/**
 * Forget any invariant failure Foundry persisted from the previous run.
 *
 * Foundry replays a persisted failing sequence before doing anything else. The
 * runner never cleared it, so one failure, from a mutant or from a flaky check,
 * replayed against every later mutant and the unmutated source alike. Every
 * contract mutant after it "failed", and every one was scored as killed. The
 * contract reported 57 of 57; with the cache cleared it scores 43 of 57.
 */
function clearPersistedFailures(target: Target): void {
  if (!target.file.endsWith('.sol')) return
  rmSync(`${target.cwd}/cache/invariant`, { recursive: true, force: true })
}

/** Returns how the suite reacted to the source currently on disk. */
function runSuite(target: Target): SuiteResult {
  clearPersistedFailures(target)
  try {
    execFileSync(target.command[0]!, target.command.slice(1), {
      cwd: target.cwd,
      stdio: 'pipe',
      timeout: MUTANT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      env: {
        ...process.env,
        // Mutants that only a deep search finds are not worth the runtime here;
        // the nightly deep run covers that. Keep mutation feedback quick.
        PROPERTY_RUNS: process.env.MUTATION_PROPERTY_RUNS ?? '150',
        PATH: `${process.env.HOME}/.foundry/bin:${process.env.PATH ?? ''}`,
      },
    })
    return 'survived' // suite passed, so the mutant lived
  } catch (error) {
    const e = error as { code?: unknown; signal?: string | null; status?: number | null }
    // Checked first: a timeout also carries a string code, ETIMEDOUT.
    if (e.signal === 'SIGKILL') {
      // The mutant hung. The runner is dead but its workers are not, and they
      // are stuck in whatever loop the mutant created.
      reapOrphanedWorkers()
      return 'timeout'
    }
    // A child killed by an interrupt did not fail a test. It was stopped.
    if (e.signal === 'SIGINT' || e.signal === 'SIGTERM') return 'interrupted'
    // A child that never ran has no exit status and no signal, only a code
    // such as ENOENT. With forge missing, every contract mutant used to count
    // as killed and the contract scored 100%.
    if (typeof e.status !== 'number') {
      throw new HarnessError(`could not run ${target.command.join(' ')}: ${String(e.code)}`)
    }
    return 'killed'
  }
}

/**
 * Run the suite on the unmutated source first. A suite that is already red, or
 * that finds no tests, "kills" every mutant it is given, and the score it
 * produces is a measurement of nothing.
 */
function baseline(target: Target): void {
  const result = runSuite(target)
  if (result === 'survived') return
  if (result === 'interrupted') return
  throw new HarnessError(
    `${target.name}: the suite does not pass on the unmutated source (${result}). ` +
      `Fix that before scoring: \`${target.command.join(' ')}\` in ${target.cwd}`,
  )
}

/** Yield to the event loop so a pending signal handler can run. */
const yieldToSignals = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

async function evaluate(target: Target, sites: readonly MutantSite[]): Promise<Outcome[]> {
  const original = readFileSync(target.file, 'utf8')
  const outcomes: Outcome[] = []

  try {
    for (const [index, site] of sites.entries()) {
      await yieldToSignals()
      if (interrupted !== null) break
      // Progress on a terminal only. In CI this would be thousands of lines
      // of carriage returns in a log nobody can read.
      if (process.stdout.isTTY) {
        process.stdout.write(`\r  ${target.name}: ${index + 1}/${sites.length}   `)
      }
      if (isKnownEquivalent(site)) {
        outcomes.push({ site, status: 'equivalent' })
        continue
      }
      pendingRestore = { file: target.file, original }
      writeFileSync(target.file, site.mutated)
      const status = runSuite(target)
      if (status === 'interrupted') {
        interrupted ??= 'SIGINT'
        break
      }
      if (status === 'timeout') {
        console.log(`\n  timeout: ${site.file}:${site.line} ${site.mutator.description}`)
      }
      outcomes.push({ site, status })
    }
  } finally {
    // Restore no matter what. A crashed run that leaves a mutant in the source
    // is a far worse outcome than a missing report.
    writeFileSync(target.file, original)
    pendingRestore = null
    rebuildIfCompiled(target)
  }
  if (process.stdout.isTTY) process.stdout.write('\r')
  return outcomes
}

// --------------------------------------------------------------------- main

const only = argValue('--target')
const limit = Number(argValue('--limit') ?? Infinity)
const targets = only === undefined ? TARGETS : TARGETS.filter((t) => t.name === only)
if (targets.length === 0) {
  console.error(`no target named ${only}. Known: ${TARGETS.map((t) => t.name).join(', ')}`)
  process.exit(1)
}

acquireLock()
// Restore and unlock even on Ctrl-C. The handler only records the signal; the
// loop sees it at its next yield, stops, and its finally restores the source.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    interrupted = signal
  })
}
process.on('exit', () => {
  // Last resort for any exit that skipped the finally, such as process.exit.
  if (pendingRestore !== null) writeFileSync(pendingRestore.file, pendingRestore.original)
  releaseLock()
  reapOrphanedWorkers()
})

const report: string[] = []
let totalKilled = 0
let totalScored = 0
let totalEquivalent = 0
const survivors: MutantSite[] = []

console.log('Mutation testing. Each mutant is a deliberate defect.\n')

for (const target of targets) {
  if (interrupted !== null) break
  const source = readFileSync(target.file, 'utf8')
  const sites = findMutants(target.file, source).slice(0, limit)
  let outcomes: Outcome[]
  try {
    baseline(target)
    outcomes = await evaluate(target, sites)
  } catch (error) {
    if (!(error instanceof HarnessError)) throw error
    console.error(`\n${error.message}`)
    process.exit(2)
  }

  // A hang is a kill: the suite would never have gone green.
  const killed = outcomes.filter((o) => o.status === 'killed' || o.status === 'timeout').length
  const timedOut = outcomes.filter((o) => o.status === 'timeout').length
  const equivalent = outcomes.filter((o) => o.status === 'equivalent').length
  const scored = outcomes.length - equivalent
  const rate = scored === 0 ? 1 : killed / scored

  totalKilled += killed
  totalScored += scored
  totalEquivalent += equivalent
  survivors.push(...outcomes.filter((o) => o.status === 'survived').map((o) => o.site))

  const line =
    `${target.name.padEnd(12)} ${killed}/${scored} killed  ${(rate * 100).toFixed(1)}%  ` +
    `(${equivalent} known equivalent, ${timedOut} killed by timeout)`
  console.log(line)
  report.push(line)
}

if (interrupted !== null) {
  // A partial score reads like a whole one. Better to report nothing.
  console.error(`\ninterrupted by ${interrupted}. Source restored; no report written.`)
  process.exit(130)
}

const overall = totalScored === 0 ? 1 : totalKilled / totalScored
console.log(`\noverall: ${totalKilled}/${totalScored} = ${(overall * 100).toFixed(1)}%`)
console.log(`known equivalent mutants excluded: ${totalEquivalent}`)

if (survivors.length > 0) {
  console.log(`\n${survivors.length} survivor(s). Each is a question, not a verdict:`)
  console.log('is it an equivalent mutant, or a gap in the tests?\n')
  for (const site of survivors) {
    console.log(`  ${site.file}:${site.line}  ${site.mutator.description}`)
    console.log(`    ${site.original}`)
  }
}

mkdirSync('qe/mutation/reports', { recursive: true })
const json = {
  generatedAt: new Date().toISOString(),
  killed: totalKilled,
  scored: totalScored,
  rate: overall,
  knownEquivalent: totalEquivalent,
  survivors: survivors.map((s) => ({
    file: s.file,
    line: s.line,
    mutator: s.mutator.id,
    description: s.mutator.description,
    source: s.original,
  })),
  equivalentRegistry: EQUIVALENT_MUTANTS.length,
}
writeFileSync('qe/mutation/reports/latest.json', `${JSON.stringify(json, null, 2)}\n`)
console.log('\nreport written to qe/mutation/reports/latest.json')
