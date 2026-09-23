/**
 * Fail the build if any test was skipped.
 *
 * A suite that silently shrinks is the worst kind of regression, because the
 * build stays green while the coverage leaves. `.skip` added to get a branch
 * merged is nearly always permanent, so it has to be a deliberate act with a
 * paper trail rather than a one-character edit nobody sees in review.
 *
 * Skipping is still allowed. It has to be declared here, with a reason and the
 * issue that will remove it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

interface AllowedSkip {
  readonly file: string
  readonly reason: string
  readonly issue: string
}

/** Empty on purpose. Adding to it is a decision someone has to defend. */
const ALLOWED: readonly AllowedSkip[] = []

const SKIP_PATTERN = /\b(?:it|test|describe)\.(?:skip|todo)\b|\bxit\b|\bxdescribe\b/

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return walk(path)
    return path.endsWith('.test.ts') || path.endsWith('.ts') ? [path] : []
  })
}

const offenders: { file: string; line: number; text: string }[] = []

for (const file of walk('qe/suites')) {
  const lines = readFileSync(file, 'utf8').split('\n')
  for (const [index, line] of lines.entries()) {
    if (!SKIP_PATTERN.test(line)) continue
    if (ALLOWED.some((a) => a.file === file)) continue
    offenders.push({ file, line: index + 1, text: line.trim() })
  }
}

if (offenders.length > 0) {
  console.error('Skipped tests are not allowed without an entry in ALLOWED:\n')
  for (const o of offenders) console.error(`  ${o.file}:${o.line}  ${o.text}`)
  console.error('\nAdd it to qe/tools/no-skips.ts with a reason and an issue, or remove the skip.')
  process.exit(1)
}

console.log('no skipped tests')
