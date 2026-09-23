// Latency under a light, steady load.
//
// Separate from the load test on purpose. Measuring latency while saturating
// the system measures queueing, not the service. Traders care about both, and
// they are different numbers with different causes, so they get different runs.

import { Trend } from 'k6/metrics'
import { MAKERS, TAKERS, pick, placeOrder, priceNear } from './lib.js'

const matchLatency = new Trend('matching_order_latency', true)
const restLatency = new Trend('resting_order_latency', true)

export const options = {
  scenarios: {
    light: {
      executor: 'constant-arrival-rate',
      rate: 50,
      timeUnit: '1s',
      duration: __ENV.DURATION || '60s',
      preAllocatedVUs: 10,
      maxVUs: 20,
    },
  },
  thresholds: {
    matching_order_latency: ['p(50)<10', 'p(99)<60'],
    resting_order_latency: ['p(50)<5', 'p(99)<30'],
  },
  summaryTrendStats: ['min', 'med', 'p(90)', 'p(95)', 'p(99)', 'p(99.9)', 'max'],
}

export default function () {
  // An order that crosses does matching work; one that rests does not. Timing
  // them together produces an average that describes neither.
  const crossing = Math.random() < 0.5
  const side = Math.random() < 0.5 ? 'buy' : 'sell'
  const price = crossing
    ? priceNear(side === 'buy' ? 105 : 95, 1)
    : priceNear(side === 'buy' ? 90 : 110, 1)

  const response = placeOrder(
    crossing ? pick(TAKERS) : pick(MAKERS),
    side,
    price,
    2,
    crossing ? 'matching' : 'resting',
  )
  ;(crossing ? matchLatency : restLatency).add(response.timings.duration)
}

export function handleSummary(data) {
  return { 'qe/suites/perf/results/latency.json': JSON.stringify(data, null, 2) }
}
