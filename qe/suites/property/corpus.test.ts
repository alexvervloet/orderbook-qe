/**
 * Replay of every saved counterexample.
 *
 * These ran once as random cases and found something. They run here as fixed
 * cases forever, so the regression is deterministic rather than probabilistic.
 *
 * The onchain half of each replay lives in the consistency suite, which needs a
 * chain. This file covers what can be checked offchain, which is cheap enough
 * to run on every pull request.
 */
import { describe, expect, it } from 'vitest'
import { ProductionMatchingEngine } from '../../../sut/backend/engine/matching-engine.ts'
import { ReferenceEngine } from '../../model/reference-engine.ts'
import { Ledger, type Market } from '../../../sut/backend/ledger.ts'
import { decodeCommand, loadCorpus, toOrderRequest } from '../../framework/corpus.ts'
import { observeState } from '../../framework/differential.ts'
import { ENGINES, replayDifferential, replayInvariants } from '../../framework/sessions.ts'

const corpus = loadCorpus()

describe('saved counterexamples', () => {
  it('has a corpus to replay', () => {
    // A corpus that quietly empties is a set of regressions that stopped being
    // checked, and nothing else would notice.
    expect(corpus.length).toBeGreaterThan(0)
  })

  for (const entry of corpus) {
    if (entry.kind === 'session') {
      describe(entry.id, () => {
        const commands = entry.commands.map(decodeCommand)

        it(`replays without the engines diverging: ${entry.summary}`, () => {
          expect(replayDifferential(commands)?.message ?? null).toBeNull()
        })

        for (const [name, create] of ENGINES) {
          it(`replays with the ${name} holding every book invariant`, () => {
            expect(replayInvariants(create, commands)?.message ?? null).toBeNull()
          })
        }
      })
      continue
    }

    describe(entry.id, () => {
      const market: Market = {
        symbol: entry.id,
        quoteScale: BigInt(entry.market.quoteScale),
        baseScale: BigInt(entry.market.baseScale),
        makerFeeBps: BigInt(entry.market.makerFeeBps),
        takerFeeBps: BigInt(entry.market.takerFeeBps),
      }
      const accounts = [...new Set(entry.actions.map((a) => `t${a.trader}`))]

      it(`replays without the engines diverging: ${entry.summary}`, () => {
        const reference = new ReferenceEngine()
        const production = new ProductionMatchingEngine()

        for (const [index, action] of entry.actions.entries()) {
          const order = toOrderRequest(action, index)
          reference.submit(order)
          production.submit(order)
        }

        expect(observeState(production, accounts)).toEqual(observeState(reference, accounts))
      })

      it('settles every trade without exhausting any balance', () => {
        const engine = new ProductionMatchingEngine()
        const ledger = new Ledger(market)
        for (const account of accounts) ledger.deposit(account, 10n ** 24n, 10n ** 30n)

        const baseAtStart = ledger.totalBase()
        const quoteAtStart = ledger.totalQuote()

        for (const [index, action] of entry.actions.entries()) {
          for (const trade of engine.submit(toOrderRequest(action, index)).trades) {
            // The original failure was an underflow during settlement. If this
            // throws, the bug is back.
            ledger.settle(trade)
          }
        }

        expect(ledger.totalBase()).toBe(baseAtStart)
        expect(ledger.totalQuote()).toBe(quoteAtStart)
      })
    })
  }
})
