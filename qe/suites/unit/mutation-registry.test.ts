/**
 * The equivalent-mutant registry has to describe mutants that exist.
 *
 * Every entry removes one mutant from the score, on the strength of an
 * argument. An entry that names an operator the runner does not have, or a
 * line that has since changed, argues about nothing, and it is exactly the
 * kind of entry nobody rereads. One such entry, for a `break-to-continue`
 * operator that was never implemented, sat in the registry unnoticed.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { EQUIVALENT_MUTANTS, isKnownEquivalent } from '../../mutation/equivalents.ts'
import { findMutants, OPERATORS } from '../../mutation/mutators.ts'

const operatorIds = new Set(OPERATORS.map((o) => o.id))

describe('the equivalent-mutant registry', () => {
  for (const entry of EQUIVALENT_MUTANTS) {
    it(`matches a real mutant: ${entry.mutator} in ${entry.file}: ${entry.source}`, () => {
      expect(operatorIds.has(entry.mutator), `no operator named ${entry.mutator}`).toBe(true)

      const sites = findMutants(entry.file, readFileSync(entry.file, 'utf8')).filter(
        (site) => site.original === entry.source && site.mutator.id === entry.mutator,
      )
      expect(sites.length, 'the line changed, or never produced this mutant').toBeGreaterThan(0)
    })
  }

  it('excuses only the operator it argues about, not the whole line', () => {
    // The reduce-only line carries ===, && and > mutants; only > is argued.
    const entry = EQUIVALENT_MUTANTS.find((e) => e.source.includes('reducesLong'))!
    const sites = findMutants(entry.file, readFileSync(entry.file, 'utf8')).filter(
      (site) => site.original === entry.source,
    )
    expect(sites.length).toBeGreaterThan(1)
    for (const site of sites) {
      expect(isKnownEquivalent(site)).toBe(site.mutator.id === entry.mutator)
    }
  })
})

describe('mutation operators', () => {
  it('leave generic type arguments alone', () => {
    const sites = findMutants('x.ts', 'const m = new Map<OrderId, Node>()\nif (a < b) go()')
    expect(sites.map((s) => s.line)).toEqual([2])
  })
})
