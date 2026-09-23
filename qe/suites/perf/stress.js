// Stress: push past the committed target until something gives, and record
// where. The question is not whether it breaks, it is whether it breaks
// safely: refusing cleanly under overload is acceptable, matching incorrectly
// is not.

import { Counter, Rate } from 'k6/metrics'
import { MAKERS, TAKERS, pick, placeOrder, priceNear } from './lib.js'

const rejected = new Counter('orders_rejected')
const errors = new Rate('transport_errors')

export const options = {
  scenarios: {
    ramp: {
      executor: 'ramping-arrival-rate',
      startRate: 100,
      timeUnit: '1s',
      preAllocatedVUs: 100,
      maxVUs: 1000,
      stages: [
        { target: 500, duration: '30s' },
        { target: 1500, duration: '30s' },
        { target: 3000, duration: '30s' },
        { target: 0, duration: '10s' },
      ],
    },
  },
  thresholds: {
    // Deliberately loose on latency and strict on correctness. Under stress
    // the platform is allowed to be slow. It is not allowed to be wrong, and
    // it is not allowed to drop connections rather than refuse requests.
    transport_errors: ['rate<0.01'],
  },
}

export default function () {
  const response = placeOrder(
    Math.random() < 0.5 ? pick(MAKERS) : pick(TAKERS),
    Math.random() < 0.5 ? 'buy' : 'sell',
    priceNear(100, 3),
    1 + Math.floor(Math.random() * 3),
    'place_order',
  )
  if (response.status === 422) rejected.add(1)
  errors.add(response.status === 0 || response.status >= 500)
}

export function handleSummary(data) {
  return { 'qe/suites/perf/results/stress.json': JSON.stringify(data, null, 2) }
}
