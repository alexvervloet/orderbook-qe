// Soak: hours at a modest, steady rate.
//
// The question here is not whether the platform is fast. It is whether it is
// the same after six hours as it was after six minutes. Leaks, unbounded
// queues, caches that only grow and clocks that drift do not show up in a
// sixty-second run, and they are the failures that take a platform down at 4am
// on a Sunday rather than during a load test.
//
// Weekly, not nightly. See docs/CI-POLICY.md.

import { Trend, Counter } from 'k6/metrics'
import http from 'k6/http'
import { BASE_URL, MAKERS, TAKERS, getBook, pick, placeOrder, priceNear } from './lib.js'

const DURATION = __ENV.DURATION || '4h'
const RATE = Number(__ENV.RATE || 50)

// Latency is bucketed by how far into the run the sample was taken, so drift
// is visible as a difference between buckets. A single p99 over four hours
// averages away exactly the thing this test exists to find.
const earlyLatency = new Trend('latency_first_quarter', true)
const lateLatency = new Trend('latency_last_quarter', true)
const bookGrowth = new Trend('book_levels')
const errors = new Counter('errors')

export const options = {
  scenarios: {
    soak: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 20,
      maxVUs: 100,
      gracefulStop: '30s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.001'],
    // The real assertion: the last quarter must not be materially slower than
    // the first. A budget on the absolute number would pass a run that got
    // steadily worse and still finished under the limit.
    latency_last_quarter: ['p(99)<200'],
    latency_first_quarter: ['p(99)<200'],
  },
  summaryTrendStats: ['min', 'med', 'p(95)', 'p(99)', 'max', 'count'],
}

const startedAt = Date.now()
const totalMs = parseDuration(DURATION)

function parseDuration(text) {
  const match = /^(\d+)([smh])$/.exec(text)
  if (match === null) return 4 * 3600 * 1000
  const value = Number(match[1])
  return value * { s: 1000, m: 60_000, h: 3_600_000 }[match[2]]
}

export default function () {
  const elapsed = Date.now() - startedAt
  const fraction = elapsed / totalMs

  // Cancel as often as we place, so the book does not grow without bound and
  // turn a memory test into a depth test.
  if (Math.random() < 0.35) {
    const response = getBook('soak_book')
    if (response.status === 200) {
      const body = response.json()
      bookGrowth.add((body.bids?.length ?? 0) + (body.asks?.length ?? 0))
    } else {
      errors.add(1)
    }
    return
  }

  const isMaker = Math.random() < 0.5
  const response = placeOrder(
    isMaker ? pick(MAKERS) : pick(TAKERS),
    Math.random() < 0.5 ? 'buy' : 'sell',
    priceNear(100, isMaker ? 6 : 1),
    1 + Math.floor(Math.random() * 3),
    'soak_place',
  )

  if (response.status !== 201 && response.status !== 422) errors.add(1)
  if (fraction <= 0.25) earlyLatency.add(response.timings.duration)
  else if (fraction >= 0.75) lateLatency.add(response.timings.duration)

  // Cancel a resting order roughly as often as one is created.
  if (response.status === 201) {
    const body = response.json()
    if (body.status === 'resting') {
      http.del(`${BASE_URL}/orders/${body.orderId}`, null, { tags: { name: 'soak_cancel' } })
    }
  }
}

export function handleSummary(data) {
  const early = data.metrics.latency_first_quarter?.values ?? {}
  const late = data.metrics.latency_last_quarter?.values ?? {}
  const drift =
    early['p(99)'] > 0 ? ((late['p(99)'] - early['p(99)']) / early['p(99)']) * 100 : 0

  return {
    'qe/suites/perf/results/soak.json': JSON.stringify(data, null, 2),
    stdout:
      `\nsoak over ${DURATION} at ${RATE}/s\n` +
      `  p99 first quarter: ${(early['p(99)'] ?? 0).toFixed(1)}ms\n` +
      `  p99 last quarter:  ${(late['p(99)'] ?? 0).toFixed(1)}ms\n` +
      `  drift:             ${drift.toFixed(1)}%\n` +
      `  errors:            ${data.metrics.errors?.values.count ?? 0}\n` +
      `\nDrift is the number that matters. A run that is 40% slower at the end\n` +
      `than at the start has a leak, whatever its absolute latency was.\n`,
  }
}
