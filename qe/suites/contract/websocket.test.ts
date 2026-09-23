/**
 * WebSocket market data contract.
 *
 * The strongest test here is the reconstruction property: apply every delta to
 * the opening snapshot and the result must equal a freshly fetched book. That
 * single assertion covers a whole family of feed bugs, including deltas that
 * omit an emptied level, deltas that send a change rather than an absolute
 * quantity, and levels updated in the wrong order. Asserting on individual
 * message contents would need a separate test for each and would still miss
 * combinations.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startHarness, type Harness } from '../../framework/harness.ts'
import { BookResponse, SubmitOrderResponse } from '../../../sut/backend/wire.ts'
import type { MarketDataMessage } from '../../../sut/backend/wire.ts'

let harness: Harness

beforeEach(async () => {
  harness = await startHarness()
  harness.exchange.deposit('alice', 10n ** 18n, 10n ** 24n)
  harness.exchange.deposit('bob', 10n ** 18n, 10n ** 24n)
})
afterEach(async () => {
  await harness.stop()
})

const place = (over: Record<string, unknown>) =>
  harness.post('/orders', { accountId: 'alice', side: 'buy', price: '100', quantity: '5', ...over })

type Levels = Map<string, { quantity: string; orderCount: number }>

/** Replay a message stream into a book, the way a client would. */
function replayFeed(messages: readonly MarketDataMessage[]): { bids: Levels; asks: Levels } {
  const bids: Levels = new Map()
  const asks: Levels = new Map()

  for (const message of messages) {
    if (message.type === 'snapshot') {
      bids.clear()
      asks.clear()
      for (const level of message.bids) {
        bids.set(level.price, { quantity: level.quantity, orderCount: level.orderCount })
      }
      for (const level of message.asks) {
        asks.set(level.price, { quantity: level.quantity, orderCount: level.orderCount })
      }
    } else if (message.type === 'delta') {
      for (const change of message.changes) {
        const side = change.side === 'buy' ? bids : asks
        if (change.quantity === '0') side.delete(change.price)
        else side.set(change.price, { quantity: change.quantity, orderCount: change.orderCount })
      }
    }
  }
  return { bids, asks }
}

function bookToLevels(book: ReturnType<typeof BookResponse.parse>): { bids: Levels; asks: Levels } {
  const bids: Levels = new Map()
  const asks: Levels = new Map()
  for (const level of book.bids) bids.set(level.price, { quantity: level.quantity, orderCount: level.orderCount })
  for (const level of book.asks) asks.set(level.price, { quantity: level.quantity, orderCount: level.orderCount })
  return { bids, asks }
}

describe('market data feed', () => {
  it('opens with a snapshot', async () => {
    const feed = await harness.marketData()
    await feed.waitFor(1)

    expect(feed.messages[0]!.type).toBe('snapshot')
  })

  it('increases the sequence by exactly one per message', async () => {
    const feed = await harness.marketData()
    await feed.waitFor(1)

    await place({ price: '100' })
    await place({ price: '99' })
    await place({ accountId: 'bob', side: 'sell', price: '101' })
    await feed.waitFor(4)

    const sequences = feed.messages.map((m) => m.sequence)
    for (let i = 1; i < sequences.length; i++) {
      expect(sequences[i]).toBe(sequences[i - 1]! + 1)
    }
  })

  it('rebuilds the exact book from the snapshot plus every delta', async () => {
    const feed = await harness.marketData()
    await feed.waitFor(1)

    // A session that adds levels, deepens one, empties one, and trades.
    await place({ price: '100', quantity: '5' })
    await place({ price: '100', quantity: '3' })
    await place({ price: '99', quantity: '2' })
    const { body } = await place({ price: '98', quantity: '1' })
    const doomed = SubmitOrderResponse.parse(body).orderId
    await place({ accountId: 'bob', side: 'sell', price: '102', quantity: '4' })
    await harness.del(`/orders/${doomed}`)
    await place({ accountId: 'bob', side: 'sell', price: '100', quantity: '6' })

    await feed.waitFor(2)
    await new Promise((resolve) => setTimeout(resolve, 50))

    const replayed = replayFeed(feed.messages)
    const fetched = bookToLevels(BookResponse.parse((await harness.get('/book')).body))

    expect(replayed.bids).toEqual(fetched.bids)
    expect(replayed.asks).toEqual(fetched.asks)
  })

  it('removes an emptied level with a zero quantity rather than omitting it', async () => {
    const feed = await harness.marketData()
    await feed.waitFor(1)

    const { body } = await place({ price: '100', quantity: '5' })
    const orderId = SubmitOrderResponse.parse(body).orderId
    await feed.waitFor(2)
    await harness.del(`/orders/${orderId}`)
    await feed.waitFor(3)

    const last = feed.messages.at(-1)!
    expect(last.type).toBe('delta')
    if (last.type !== 'delta') throw new Error('unreachable')
    expect(last.changes).toContainEqual({
      side: 'buy',
      price: '100',
      quantity: '0',
      orderCount: 0,
    })
  })

  it('publishes a trade message alongside the book change', async () => {
    const feed = await harness.marketData()
    await feed.waitFor(1)

    await place({ accountId: 'bob', side: 'sell', price: '100', quantity: '2' })
    await place({ accountId: 'alice', side: 'buy', price: '100', quantity: '2' })
    await feed.waitFor(3)

    const trades = feed.messages.filter((m) => m.type === 'trade')
    expect(trades).toHaveLength(1)
    expect(trades[0]).toMatchObject({ price: '100', quantity: '2', takerSide: 'buy' })
  })

  it('gives a late subscriber a snapshot that already reflects earlier activity', async () => {
    await place({ price: '100', quantity: '5' })

    const feed = await harness.marketData()
    await feed.waitFor(1)

    const first = feed.messages[0]!
    expect(first.type).toBe('snapshot')
    if (first.type !== 'snapshot') throw new Error('unreachable')
    expect(first.bids).toContainEqual({ price: '100', quantity: '5', orderCount: 1 })
  })

  it('lets a reconnecting client detect a gap and recover by re-snapshotting', async () => {
    const first = await harness.marketData()
    await first.waitFor(1)
    await place({ price: '100', quantity: '5' })
    await first.waitFor(2)
    const lastSeen = first.messages.at(-1)!.sequence
    await first.close()

    // Activity the disconnected client misses entirely.
    await place({ price: '99', quantity: '7' })
    await place({ price: '98', quantity: '3' })

    const second = await harness.marketData()
    await second.waitFor(1)
    const resumed = second.messages[0]!

    // The gap is visible, which is the point: the client can tell it missed
    // messages instead of silently carrying a stale book.
    expect(resumed.sequence).toBeGreaterThan(lastSeen + 1)

    // And the fresh snapshot is complete, so recovery is possible.
    const replayed = replayFeed(second.messages)
    const fetched = bookToLevels(BookResponse.parse((await harness.get('/book')).body))
    expect(replayed.bids).toEqual(fetched.bids)
  })
})
