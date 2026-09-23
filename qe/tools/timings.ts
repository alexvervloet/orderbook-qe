/**
 * Measure what every suite costs.
 *
 * docs/CI-POLICY.md decides what runs on a pull request and what runs nightly,
 * and that decision is only defensible if the numbers behind it are real. This
 * regenerates them.
 *
 * Run it when a suite is added or when the policy table starts to feel wrong.
 * A tiering table nobody has re-measured is a description of a repository that
 * no longer exists.
 */
import { execFileSync } from 'node:child_process'

interface Measurement {
  readonly label: string
  readonly command: readonly string[]
  readonly cwd?: string
  readonly env?: Record<string, string>
}

const MEASUREMENTS: readonly Measurement[] = [
  { label: 'lint', command: ['npx', 'oxlint', 'spec', 'qe', 'sut'] },
  { label: 'typecheck', command: ['npx', 'tsc', '--noEmit'] },
  { label: 'unit', command: ['npx', 'vitest', 'run', 'qe/suites/unit'] },
  { label: 'integration', command: ['npx', 'vitest', 'run', 'qe/suites/integration'] },
  { label: 'property (PR depth)', command: ['npx', 'vitest', 'run', 'qe/suites/property'] },
  { label: 'contract', command: ['npx', 'vitest', 'run', 'qe/suites/contract'] },
  { label: 'consistency (PR depth)', command: ['npx', 'vitest', 'run', 'qe/suites/consistency'] },
  { label: 'forge unit + fuzz', command: ['forge', 'test', '--no-match-contract', 'Invariant'], cwd: 'sut/contracts' },
  { label: 'forge invariants', command: ['forge', 'test', '--match-contract', 'Invariant'], cwd: 'sut/contracts' },
  {
    label: 'property (nightly)',
    command: ['npx', 'vitest', 'run', 'qe/suites/property'],
    env: { PROPERTY_RUNS: '20000' },
  },
  {
    label: 'consistency (nightly)',
    command: ['npx', 'vitest', 'run', 'qe/suites/consistency'],
    env: { CONSISTENCY_RUNS: '40' },
  },
  {
    label: 'forge invariants (nightly)',
    command: ['forge', 'test', '--match-contract', 'Invariant'],
    cwd: 'sut/contracts',
    env: { FOUNDRY_PROFILE: 'nightly' },
  },
]

console.log('label'.padEnd(30), 'ms'.padStart(8), ' status')
console.log('-'.repeat(50))

let prTotal = 0
for (const measurement of MEASUREMENTS) {
  const started = Date.now()
  let ok = true
  try {
    execFileSync(measurement.command[0]!, measurement.command.slice(1), {
      cwd: measurement.cwd ?? '.',
      stdio: 'pipe',
      env: {
        ...process.env,
        ...measurement.env,
        PATH: `${process.env.HOME}/.foundry/bin:${process.env.PATH ?? ''}`,
      },
    })
  } catch {
    ok = false
  }
  const elapsed = Date.now() - started
  if (!measurement.label.includes('nightly')) prTotal += elapsed
  console.log(
    measurement.label.padEnd(30),
    String(elapsed).padStart(8),
    ok ? ' ok' : ' FAILED',
  )
}

console.log('-'.repeat(50))
console.log('pull request total'.padEnd(30), String(prTotal).padStart(8))
console.log(`\nbudget is 5 minutes (300000 ms). Using ${((prTotal / 300_000) * 100).toFixed(1)}%.`)
console.log('The container build is not measured here; add roughly 40s for it.')
