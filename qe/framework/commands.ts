/**
 * Generators for random trading sessions.
 *
 * The generator is tuned to make interesting things happen rather than to be
 * uniform. Prices sit in a narrow band so orders actually cross. Accounts are
 * few so self-trades are common. Cancels target orders that were really
 * submitted rather than random strings, because cancelling an unknown id
 * exercises one branch and cancelling a live order exercises the rest.
 *
 * A uniform generator over this space would spend almost all its time on empty
 * books and unmatched orders, and would find nothing.
 */
import fc from 'fast-check'
import type { OrderRequest, StpMode, TimeInForce } from '../../spec/types.ts'

export const ACCOUNTS = ['alice', 'bob', 'carol'] as const

export type Command =
  | { readonly kind: 'submit'; readonly request: OrderRequest }
  /** Resolved against the ids submitted so far, so most cancels hit something. */
  | { readonly kind: 'cancel'; readonly targetIndex: number }

const price = fc.integer({ min: 95, max: 105 }).map(BigInt)
const quantity = fc.integer({ min: 1, max: 10 }).map(BigInt)
const account = fc.constantFrom(...ACCOUNTS)
const tif = fc.constantFrom<TimeInForce>('GTC', 'GTC', 'GTC', 'IOC', 'FOK')
const stp = fc.constantFrom<StpMode>('none', 'none', 'cancel_taker', 'cancel_maker', 'cancel_both')
const side = fc.constantFrom('buy' as const, 'sell' as const)

/** Ids are positional so both engines receive an identical sequence. */
function orderRequest(index: number): fc.Arbitrary<OrderRequest> {
  return fc
    .record({
      accountId: account,
      side,
      quantity,
      price,
      tif,
      stpMode: stp,
      shape: fc.constantFrom(
        'limit',
        'limit',
        'limit',
        'market',
        'post_only',
        'iceberg',
        'reduce_only',
        'stop_market',
        'stop_limit',
      ),
      displayDivisor: fc.integer({ min: 2, max: 4 }),
      triggerOffset: fc.integer({ min: -4, max: 4 }),
    })
    .map(
      ({
        accountId,
        side: s,
        quantity: qty,
        price: px,
        tif: t,
        stpMode,
        shape,
        displayDivisor,
        triggerOffset,
      }): OrderRequest => {
        const base = {
          id: `o${index}`,
          accountId,
          side: s,
          quantity: qty,
          displayQuantity: null,
          postOnly: false,
          reduceOnly: false,
          triggerPrice: null,
          stpMode,
        }
        // Every shape takes the generated time in force. The first version
        // pinned most of them (market always IOC, stops and icebergs always
        // one TIF), so a market FOK, a post-only IOC or a stop_limit FOK were
        // never generated, and those are the combinations sections 4 to 6 of
        // the spec spend the most words on.
        switch (shape) {
          case 'market':
            return { ...base, type: 'market', tif: t, price: null }
          case 'post_only':
            return { ...base, type: 'limit', tif: t, price: px, postOnly: true }
          case 'iceberg': {
            const display = qty / BigInt(displayDivisor)
            return {
              ...base,
              type: 'limit',
              tif: t,
              price: px,
              displayQuantity: display > 0n ? display : 1n,
            }
          }
          case 'reduce_only':
            return { ...base, type: 'limit', tif: t, price: px, reduceOnly: true }
          case 'stop_market':
            return {
              ...base,
              type: 'stop_market',
              tif: t,
              price: null,
              triggerPrice: px + BigInt(triggerOffset),
            }
          case 'stop_limit':
            return {
              ...base,
              type: 'stop_limit',
              tif: t,
              price: px,
              triggerPrice: px + BigInt(triggerOffset),
            }
          default:
            return { ...base, type: 'limit', tif: t, price: px }
        }
      },
    )
}

export function commandSequence(maxLength: number): fc.Arbitrary<Command[]> {
  return fc
    .array(
      fc.record({
        cancel: fc.boolean(),
        targetIndex: fc.nat({ max: 200 }),
        seed: fc.nat({ max: 1_000_000 }),
      }),
      // `size: 'max'` and a real minimum matter more than they look. Left to its
      // defaults, fc.array is biased toward short arrays: a maxLength of 40 gave
      // a mean session of six commands, which is not enough to build a book
      // deep enough for anything interesting to go wrong. See LESSONS.md.
      { minLength: Math.min(15, maxLength), maxLength, size: 'max' },
    )
    .chain((slots) =>
      fc.tuple(
        ...slots.map((slot, index) =>
          // One cancel in five, so the book gets a chance to build up.
          slot.cancel && index % 5 === 0
            ? fc.constant<Command>({ kind: 'cancel', targetIndex: slot.targetIndex })
            : orderRequest(index).map<Command>((request) => ({ kind: 'submit', request })),
        ),
      ),
    )
}

/** Render a command sequence as runnable-looking text for a failure report. */
export function describeCommands(commands: readonly Command[]): string {
  return commands
    .map((c, i) => {
      if (c.kind === 'cancel') return `${i}: cancel(index ${c.targetIndex})`
      const r = c.request
      const bits = [
        r.id,
        r.accountId,
        r.side,
        r.type,
        r.tif,
        `qty=${r.quantity}`,
        r.price === null ? 'price=mkt' : `price=${r.price}`,
      ]
      if (r.displayQuantity !== null) bits.push(`display=${r.displayQuantity}`)
      if (r.postOnly) bits.push('postOnly')
      if (r.reduceOnly) bits.push('reduceOnly')
      if (r.triggerPrice !== null) bits.push(`trigger=${r.triggerPrice}`)
      if (r.stpMode !== 'none') bits.push(`stp=${r.stpMode}`)
      return `${i}: submit(${bits.join(' ')})`
    })
    .join('\n')
}
