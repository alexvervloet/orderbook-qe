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
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
  readonly status: 'killed' | 'survived' | 'equivalent' | 'uncompilable'
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}

function runSuite(target: Target): boolean {
  try {
    execFileSync(target.command[0]!, target.command.slice(1), {
      cwd: target.cwd,
      stdio: 'pipe',
      env: {
        ...process.env,
        // Mutants that only a deep search finds are not worth the runtime here;
        // the nightly deep run covers that. Keep mutation feedback quick.
        PROPERTY_RUNS: process.env.MUTATION_PROPERTY_RUNS ?? '150',
        PATH: `${process.env.HOME}/.foundry/bin:${process.env.PATH ?? ''}`,
      },
    })
    return false // suite passed, so the mutant lived
  } catch {
    return true // suite failed, so the mutant was killed
  }
}

function evaluate(target: Target, sites: readonly MutantSite[]): Outcome[] {
  const original = readFileSync(target.file, 'utf8')
  const outcomes: Outcome[] = []

  try {
    for (const [index, site] of sites.entries()) {
      // Progress on a terminal only. In CI this would be thousands of lines
      // of carriage returns in a log nobody can read.
      if (process.stdout.isTTY) {
        process.stdout.write(`\r  ${target.name}: ${index + 1}/${sites.length}   `)
      }
      if (isKnownEquivalent(site)) {
        outcomes.push({ site, status: 'equivalent' })
        continue
      }
      writeFileSync(target.file, site.mutated)
      outcomes.push({ site, status: runSuite(target) ? 'killed' : 'survived' })
    }
  } finally {
    // Restore no matter what. A crashed run that leaves a mutant in the source
    // is a far worse outcome than a missing report.
    writeFileSync(target.file, original)
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

const report: string[] = []
let totalKilled = 0
let totalScored = 0
let totalEquivalent = 0
const survivors: MutantSite[] = []

console.log('Mutation testing. Each mutant is a deliberate defect.\n')

for (const target of targets) {
  const source = readFileSync(target.file, 'utf8')
  const sites = findMutants(target.file, source).slice(0, limit)
  const outcomes = evaluate(target, sites)

  const killed = outcomes.filter((o) => o.status === 'killed').length
  const equivalent = outcomes.filter((o) => o.status === 'equivalent').length
  const scored = outcomes.length - equivalent
  const rate = scored === 0 ? 1 : killed / scored

  totalKilled += killed
  totalScored += scored
  totalEquivalent += equivalent
  survivors.push(...outcomes.filter((o) => o.status === 'survived').map((o) => o.site))

  const line = `${target.name.padEnd(12)} ${killed}/${scored} killed  ${(rate * 100).toFixed(1)}%  (${equivalent} known equivalent)`
  console.log(line)
  report.push(line)
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
