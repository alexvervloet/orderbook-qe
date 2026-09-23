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
      // Two orders per iteration, so 50 requests a second.
      rate: 25,
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
  //
  // Each iteration rests a maker and then sends a taker at the same price, so
  // the taker has something to cross. The first version guessed instead: its
  // "crossing" buys at 104 to 106 sat below asks at 109 to 111, and in a
  // simulation half of the "matching" samples were plain inserts.
  const makerSide = Math.random() < 0.5 ? 'buy' : 'sell'
  const takerSide = makerSide === 'buy' ? 'sell' : 'buy'
  const price = priceNear(makerSide === 'buy' ? 90 : 110, 1)

  record(placeOrder(pick(MAKERS), makerSide, price, 2, 'resting'))
  record(placeOrder(pick(TAKERS), takerSide, price, 2, 'matching'))
}

/**
 * File the sample by what the order actually did, not by what it was meant to
 * do. A refused maker leaves the taker nothing to cross, and that taker's
 * latency is an insert's, whatever it was tagged.
 */
function record(response) {
  if (response.status !== 201) return
  const body = response.json()
  if (Number(body.filled) > 0) matchLatency.add(response.timings.duration)
  else if (body.status === 'resting') restLatency.add(response.timings.duration)
}

export function handleSummary(data) {
  return { 'qe/suites/perf/results/latency.json': JSON.stringify(data, null, 2) }
}
