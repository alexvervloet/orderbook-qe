// Shared helpers for the k6 suites.
//
// Every scenario trades against the same seeded accounts the container creates,
// so a load test and an end-to-end test are exercising the same data. See
// docs/TEST-DATA.md.

import http from 'k6/http'
import { check } from 'k6'

export const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080'

export const MAKERS = ['maker-1', 'maker-2']
export const TAKERS = ['taker-1', 'taker-2']

const JSON_HEADERS = { 'content-type': 'application/json' }

/**
 * Prices cluster around a mid so orders actually cross. A load test that
 * places orders nobody can match measures the cost of an insert, not the cost
 * of a trade, and matching is the expensive part.
 */
export function priceNear(mid, spread) {
  return String(mid + Math.floor(Math.random() * (2 * spread + 1)) - spread)
}

export function placeOrder(accountId, side, price, quantity, tag) {
  const response = http.post(
    `${BASE_URL}/orders`,
    JSON.stringify({ accountId, side, price, quantity: String(quantity) }),
    { headers: JSON_HEADERS, tags: { name: tag || 'place_order' } },
  )
  check(response, {
    // 201 accepted, 422 refused for a stated reason. Both are the exchange
    // working. Anything else is not.
    'order handled': (r) => r.status === 201 || r.status === 422,
  })
  return response
}

export function getBook(tag) {
  const response = http.get(`${BASE_URL}/book`, { tags: { name: tag || 'get_book' } })
  check(response, { 'book returned': (r) => r.status === 200 })
  return response
}

export function pick(list) {
  return list[Math.floor(Math.random() * list.length)]
}
