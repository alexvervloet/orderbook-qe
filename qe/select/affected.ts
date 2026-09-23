/**
 * Changed files to affected suites.
 *
 * Built, and deliberately not used on the pull request tier yet.
 *
 * The full pull-request suite runs in under a minute, and skipping tests to
 * save forty seconds trades a certainty for a risk at a bad exchange rate. A
 * selection map that has never been wrong is a selection map nobody has
 * checked, and the way it goes wrong is silent: a change lands, the suite that
 * would have caught it was not selected, and the build is green.
 *
 * So this exists for when the suite outgrows the budget, and until then it runs
 * in advisory mode: CI prints what it would have selected against what it
 * actually ran, so the map is continuously checked against reality before
 * anything depends on it.
 *
 *   npm run select -- $(git diff --name-only origin/main)
 */

export interface Rule {
  /** Matched against each changed path. */
  readonly pattern: RegExp
  readonly suites: readonly string[]
  readonly why: string
}

/**
 * Order matters: the first matching rule wins, so the specific rules come
 * before the broad ones.
 */
export const RULES: readonly Rule[] = [
  {
    pattern: /^spec\//,
    suites: ['ALL'],
    why: 'The spec is the contract both engines implement. A change here can invalidate any suite.',
  },
  {
    pattern: /^sut\/contracts\//,
    suites: ['solidity', 'consistency'],
    why: 'Contract changes affect onchain behaviour and the offchain/onchain comparison.',
  },
  {
    pattern: /^sut\/backend\/engine\//,
    suites: ['unit', 'property', 'integration', 'consistency', 'contract', 'e2e'],
    why: 'Everything sits on top of matching, so a change here reaches every layer.',
  },
  {
    pattern: /^sut\/backend\/ledger\.ts$/,
    suites: ['property', 'integration', 'consistency', 'contract'],
    why: 'Settlement arithmetic, compared against the contract and asserted as conservation properties.',
  },
  {
    pattern: /^sut\/backend\/(exchange|wire|server|seed|main)\.ts$/,
    suites: ['contract', 'integration', 'e2e'],
    why: 'Service surface: protocols, serialisation and the paths the browser drives.',
  },
  {
    pattern: /^sut\/frontend\//,
    suites: ['e2e'],
    why: 'Only the browser exercises the UI.',
  },
  {
    pattern: /^qe\/model\//,
    suites: ['unit', 'property'],
    why: 'The oracle is used by the conformance and differential suites.',
  },
  {
    pattern: /^qe\/framework\//,
    suites: ['ALL'],
    why: 'Shared equipment. A broken harness can make any suite pass while testing nothing.',
  },
  {
    pattern: /^qe\/suites\/([^/]+)\//,
    suites: ['SELF'],
    why: 'A change to a suite runs that suite.',
  },
  {
    pattern: /^(package\.json|package-lock\.json|tsconfig\.json|vitest\.config\.ts|Dockerfile|docker-compose\.yml)$/,
    suites: ['ALL'],
    why: 'Build and dependency changes can break anything, usually in ways nobody predicts.',
  },
]

export const ALL_SUITES = [
  'unit',
  'property',
  'contract',
  'integration',
  'consistency',
  'solidity',
  'e2e',
] as const

export interface Selection {
  readonly suites: readonly string[]
  readonly reasons: readonly string[]
  /** True when a changed path matched no rule at all. */
  readonly unmatched: readonly string[]
}

export function select(changedFiles: readonly string[]): Selection {
  const suites = new Set<string>()
  const reasons: string[] = []
  const unmatched: string[] = []

  for (const file of changedFiles) {
    const rule = RULES.find((r) => r.pattern.test(file))
    if (rule === undefined) {
      // An unmatched path is not "no suites". It is a hole in the map, and the
      // safe reading of a hole is everything.
      unmatched.push(file)
      for (const suite of ALL_SUITES) suites.add(suite)
      continue
    }

    for (const suite of rule.suites) {
      if (suite === 'ALL') for (const s of ALL_SUITES) suites.add(s)
      else if (suite === 'SELF') {
        const match = /^qe\/suites\/([^/]+)\//.exec(file)
        if (match?.[1] !== undefined) suites.add(match[1])
      } else suites.add(suite)
    }
    reasons.push(`${file}: ${rule.why}`)
  }

  return { suites: [...suites].sort(), reasons, unmatched }
}

// ---------------------------------------------------------------- cli

if (process.argv[1]?.endsWith('affected.ts') === true) {
  const changed = process.argv.slice(2).filter((arg) => arg.length > 0)
  if (changed.length === 0) {
    console.log('usage: npm run select -- <changed files>')
    process.exit(0)
  }

  const selection = select(changed)
  console.log(`selected: ${selection.suites.join(', ') || '(none)'}`)
  if (selection.unmatched.length > 0) {
    console.log(`\nunmatched paths, so everything was selected:`)
    for (const file of selection.unmatched) console.log(`  ${file}`)
    console.log('Add a rule for these, or leave them to select everything on purpose.')
  }
  console.log('\nwhy:')
  for (const reason of new Set(selection.reasons)) console.log(`  ${reason}`)
  console.log('\nAdvisory only. The pull request tier still runs everything. See the file header.')
}
