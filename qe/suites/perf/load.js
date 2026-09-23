// Load: the throughput the platform has committed to for public testnet, plus
// headroom. Not the largest number this machine can produce. See
// docs/NON-GOALS.md for why the distinction matters.

import { Trend } from 'k6/metrics'
import { BASE_URL, MAKERS, TAKERS, getBook, pick, placeOrder, priceNear } from './lib.js'

// The committed target, in orders per second, and the multiple we hold above
// it. Both are arguments, not discoveries: change them when the commitment
// changes.
const TARGET_ORDERS_PER_SECOND = Number(__ENV.TARGET_OPS || 200)
const HEADROOM = Number(__ENV.HEADROOM || 2)

const placeLatency = new Trend('order_place_latency', true)

export const options = {
  scenarios: {
    steady: {
      executor: 'constant-arrival-rate',
      rate: TARGET_ORDERS_PER_SECOND * HEADROOM,
      timeUnit: '1s',
      duration: __ENV.DURATION || '60s',
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
  },
  thresholds: {
    // Budgets, not observations. A threshold set to whatever the system
    // currently does is a record of the past, not a requirement.
    http_req_failed: ['rate<0.001'],
    'http_req_duration{name:place_order}': ['p(95)<50', 'p(99)<150'],
    'http_req_duration{name:get_book}': ['p(95)<20'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(95)', 'p(99)', 'max'],
}

export default function () {
  // Nine orders to one book read, which is roughly what a market-making client
  // does. A 50/50 split would understate the cost of the write path.
  if (Math.random() < 0.1) {
    getBook()
    return
  }
  const isMaker = Math.random() < 0.5
  const account = isMaker ? pick(MAKERS) : pick(TAKERS)
  const side = Math.random() < 0.5 ? 'buy' : 'sell'
  const response = placeOrder(account, side, priceNear(100, isMaker ? 5 : 1), 1 + Math.floor(Math.random() * 5))
  placeLatency.add(response.timings.duration)
}

export function handleSummary(data) {
  return {
    'qe/suites/perf/results/load.json': JSON.stringify(data, null, 2),
    stdout: `\nload: target ${TARGET_ORDERS_PER_SECOND}/s at ${HEADROOM}x against ${BASE_URL}\n`,
  }
}
