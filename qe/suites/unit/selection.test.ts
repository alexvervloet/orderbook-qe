/**
 * The test-selection map is itself tested.
 *
 * A selection map fails silently: the wrong answer means a suite does not run,
 * the build goes green, and nobody finds out until production. It needs the
 * same treatment as any other piece of logic that can be quietly wrong.
 */
import { describe, expect, it } from 'vitest'
import { ALL_SUITES, select } from '../../select/affected.ts'

describe('test selection', () => {
  it('runs everything when the spec changes', () => {
    expect(select(['spec/SEMANTICS.md']).suites).toEqual([...ALL_SUITES].sort())
  })

  it('runs every layer when the matching engine changes', () => {
    const { suites } = select(['sut/backend/engine/matching-engine.ts'])

    expect(suites).toContain('unit')
    expect(suites).toContain('property')
    expect(suites).toContain('consistency')
  })

  it('runs only the browser suite for a frontend-only change', () => {
    expect(select(['sut/frontend/app.js']).suites).toEqual(['e2e'])
  })

  it('runs the solidity, consistency and reorg suites for a contract change', () => {
    expect(select(['sut/contracts/src/OrderBookExchange.sol']).suites).toEqual([
      'chaos',
      'consistency',
      'solidity',
    ])
  })

  it('runs the chaos suite when the engine or ledger it imports changes', () => {
    expect(select(['sut/backend/engine/matching-engine.ts']).suites).toContain('chaos')
    expect(select(['sut/backend/ledger.ts']).suites).toContain('chaos')
  })

  it('runs a suite when that suite changes', () => {
    expect(select(['qe/suites/property/differential.test.ts']).suites).toEqual(['property'])
  })

  it('runs everything when shared test equipment changes', () => {
    // The framework can make any suite pass while testing nothing, so a change
    // to it is not a narrow change.
    expect(select(['qe/framework/commands.ts']).suites).toEqual([...ALL_SUITES].sort())
  })

  it('runs everything for a path the map does not cover', () => {
    const selection = select(['some/new/place/thing.ts'])

    expect(selection.unmatched).toEqual(['some/new/place/thing.ts'])
    expect(selection.suites).toEqual([...ALL_SUITES].sort())
  })

  it('unions the suites across several changed files', () => {
    const { suites } = select(['sut/frontend/app.js', 'sut/contracts/src/OrderBookExchange.sol'])

    expect(suites).toEqual(['chaos', 'consistency', 'e2e', 'solidity'])
  })
})
