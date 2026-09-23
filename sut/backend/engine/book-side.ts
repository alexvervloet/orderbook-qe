/**
 * One side of an order book.
 *
 * Price levels live in a map keyed by price. Each level holds its resting
 * orders in an intrusive doubly linked list, so cancelling an order is a
 * pointer rewrite rather than a scan. A separate array keeps the occupied
 * prices sorted best-first, maintained by binary search on insert and remove.
 *
 * Three pieces of state have to agree at all times: the linked list, the
 * level's cached `displayedTotal` and `orderCount`, and the sorted price array.
 * Incremental maintenance of a cached aggregate is where order books usually go
 * wrong, and the differential test exists to notice when this one does.
 */
import type { Lots, OrderRequest, Sequence, Side, Ticks } from '../../../spec/types.ts'

export interface Node {
  readonly request: OrderRequest
  sequence: Sequence
  remaining: Lots
  displayed: Lots
  prev: Node | null
  next: Node | null
  level: Level
}

export interface Level {
  readonly price: Ticks
  head: Node | null
  tail: Node | null
  /** Sum of `displayed` over the list. Cached, not recomputed. */
  displayedTotal: Lots
  orderCount: number
}

export class BookSide {
  readonly #side: Side
  readonly #levels = new Map<Ticks, Level>()
  /** Occupied prices, best first: descending for bids, ascending for asks. */
  readonly #prices: Ticks[] = []

  constructor(side: Side) {
    this.#side = side
  }

  get side(): Side {
    return this.#side
  }

  /** Best price, or null when the side is empty. */
  bestPrice(): Ticks | null {
    return this.#prices[0] ?? null
  }

  bestNode(): Node | null {
    const price = this.#prices[0]
    if (price === undefined) return null
    return this.#levels.get(price)?.head ?? null
  }

  /** Occupied prices in priority order. */
  prices(): readonly Ticks[] {
    return this.#prices
  }

  level(price: Ticks): Level | undefined {
    return this.#levels.get(price)
  }

  /** Append to the back of the queue at `price`, creating the level if needed. */
  append(request: OrderRequest, sequence: Sequence, remaining: Lots, displayed: Lots): Node {
    const price = request.price!
    let level = this.#levels.get(price)
    if (level === undefined) {
      level = { price, head: null, tail: null, displayedTotal: 0n, orderCount: 0 }
      this.#levels.set(price, level)
      this.#insertPrice(price)
    }

    const node: Node = {
      request,
      sequence,
      remaining,
      displayed,
      prev: level.tail,
      next: null,
      level,
    }
    if (level.tail === null) {
      level.head = node
    } else {
      level.tail.next = node
    }
    level.tail = node
    level.displayedTotal += displayed
    level.orderCount += 1
    return node
  }

  /** Unlink a node. Drops the level when it empties. */
  remove(node: Node): void {
    const level = node.level
    if (node.prev === null) {
      level.head = node.next
    } else {
      node.prev.next = node.next
    }
    if (node.next === null) {
      level.tail = node.prev
    } else {
      node.next.prev = node.prev
    }
    node.prev = null
    node.next = null

    level.displayedTotal -= node.displayed
    level.orderCount -= 1

    if (level.head === null) {
      this.#levels.delete(level.price)
      this.#removePrice(level.price)
    }
  }

  /**
   * Reduce a node's displayed size, keeping the level aggregate in step. The
   * only sanctioned way to change `displayed` on a linked node.
   */
  reduceDisplayed(node: Node, by: Lots): void {
    node.displayed -= by
    node.level.displayedTotal -= by
  }

  /**
   * Move a node to the back of its own price level with a new sequence number.
   * An iceberg refresh, which costs time priority by design.
   */
  moveToBack(node: Node, sequence: Sequence, newDisplayed: Lots): void {
    const level = node.level
    // Unlink without touching the aggregates; the node is staying in the level.
    if (node.prev === null) level.head = node.next
    else node.prev.next = node.next
    if (node.next === null) level.tail = node.prev
    else node.next.prev = node.prev

    level.displayedTotal += newDisplayed - node.displayed
    node.displayed = newDisplayed
    node.sequence = sequence
    node.prev = level.tail
    node.next = null
    if (level.tail === null) level.head = node
    else level.tail.next = node
    level.tail = node
  }

  /** Every resting node, best price first, then queue order within a level. */
  *nodes(): Generator<Node> {
    for (const price of this.#prices) {
      let node = this.#levels.get(price)?.head ?? null
      while (node !== null) {
        yield node
        node = node.next
      }
    }
  }

  #isBetter(a: Ticks, b: Ticks): boolean {
    return this.#side === 'buy' ? a > b : a < b
  }

  /** Index where `price` belongs in the best-first array. */
  #locate(price: Ticks): number {
    let low = 0
    let high = this.#prices.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (this.#isBetter(this.#prices[mid]!, price)) low = mid + 1
      else high = mid
    }
    return low
  }

  #insertPrice(price: Ticks): void {
    this.#prices.splice(this.#locate(price), 0, price)
  }

  #removePrice(price: Ticks): void {
    const index = this.#locate(price)
    if (this.#prices[index] === price) this.#prices.splice(index, 1)
  }
}
