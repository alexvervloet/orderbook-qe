/**
 * Network fault injection against the real backend.
 *
 * Requires the chaos compose profile:
 *
 *   docker compose --profile chaos up -d --wait
 *
 * Skipped, loudly, when Toxiproxy is not reachable. A suite that silently
 * passes when its dependency is missing reports success for work it never did,
 * and on a nightly job nobody would ever notice.
 *
 * What these assert is not that the platform is fast under bad conditions. It
 * is that it degrades in ways a client can act on: a timeout is a timeout, a
 * refusal is a refusal, and nothing reports success for an order that did not
 * happen.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createToxiproxyClient,
  toxiproxyAvailable,
  type Proxy,
} from '../../framework/toxiproxy.ts'

const BACKEND_UPSTREAM = process.env.CHAOS_UPSTREAM ?? 'backend:8080'
const PROXY_PORT = Number(process.env.CHAOS_PROXY_PORT ?? 8666)

let proxy: Proxy
let baseUrl = ''

/**
 * Checked at module load, not in `beforeAll`.
 *
 * Vitest registers `describe` blocks during collection, which happens before
 * any hook runs. A flag set in `beforeAll` is still false when
 * `describe.skip` is decided, so the whole suite skips no matter what. It did
 * exactly that against a healthy Toxiproxy until this moved up here.
 */
const available = await toxiproxyAvailable()

beforeAll(async () => {
  if (!available) return
  const client = createToxiproxyClient()
  await client.reset()
  proxy = await client.createProxy('exchange', PROXY_PORT, BACKEND_UPSTREAM)
  baseUrl = `http://${proxy.listenAddress}`
}, 30_000)

afterAll(async () => {
  if (available) await proxy?.destroy().catch(() => undefined)
})

const describeIfAvailable = (): typeof describe | typeof describe.skip =>
  available ? describe : describe.skip

async function placeOrder(timeoutMs: number): Promise<Response> {
  return fetch(`${baseUrl}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      accountId: 'maker-1',
      side: 'sell',
      price: '100',
      quantity: '1',
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })
}

describe('network faults', () => {
  it('reports whether Toxiproxy was reachable, so a skip is visible', () => {
    if (!available) {
      console.warn(
        `Toxiproxy not reachable. These tests did NOT run.\n` +
          `  docker compose --profile chaos up -d --wait`,
      )
    }
    expect(typeof available).toBe('boolean')
  })

  describeIfAvailable()('under added latency', () => {
    it('still returns a correct result, just later', async () => {
      // Jitter is zero on purpose. My first version used 50ms of jitter and
      // then asserted a hard floor at the nominal latency, which fails roughly
      // half the time by construction. A fault-injection test that is itself
      // non-deterministic is the exact thing docs/CI-POLICY.md says to delete.
      const INJECTED_MS = 400
      await proxy.addToxic({
        name: 'slow',
        type: 'latency',
        attributes: { latency: INJECTED_MS, jitter: 0 },
      })
      try {
        const started = Date.now()
        const response = await placeOrder(5_000)
        const elapsed = Date.now() - started

        expect(response.status).toBe(201)
        // Generous margin below the nominal figure. The claim being made is
        // "the toxic was applied", and the baseline is single-digit
        // milliseconds, so anything near 400 proves it without asserting on
        // scheduler precision.
        expect(elapsed).toBeGreaterThan(INJECTED_MS * 0.75)
        // Correctness must not depend on timing. An exchange that matches
        // differently when the network is slow has a race, not a latency issue.
        const body = (await response.json()) as { status: string; remaining: string }
        expect(body.status).toBe('resting')
        expect(body.remaining).toBe('1')
      } finally {
        await proxy.removeToxic('slow')
      }
    }, 20_000)
  })

  describeIfAvailable()('when the connection is cut', () => {
    it('fails the request rather than hanging or reporting success', async () => {
      await proxy.cut()
      try {
        await expect(placeOrder(2_000)).rejects.toThrow()
      } finally {
        await proxy.restore()
      }
    }, 20_000)

    it('serves correctly again once the link is restored', async () => {
      // Recovery is the half of a fault-injection test people forget. A system
      // that survives the fault and never comes back has still failed.
      const response = await placeOrder(5_000)

      expect(response.status).toBe(201)
    }, 20_000)

    it('did not lose or duplicate the order placed during the outage', async () => {
      // The request that failed must not have been applied. A cut connection
      // that still books the order is the worst outcome: the client retries and
      // ends up with two positions.
      const before = await (await fetch(`${baseUrl}/book`)).json()

      await proxy.cut()
      await placeOrder(1_000).catch(() => undefined)
      await proxy.restore()

      const after = await (await fetch(`${baseUrl}/book`)).json()
      expect(after).toEqual(before)
    }, 20_000)
  })

  describeIfAvailable()('under a constrained link', () => {
    it('completes a large read rather than truncating it', async () => {
      await proxy.addToxic({
        name: 'narrow',
        type: 'bandwidth',
        attributes: { rate: 8 }, // KB/s
      })
      try {
        const response = await fetch(`${baseUrl}/book`, { signal: AbortSignal.timeout(15_000) })
        const body = await response.text()

        expect(response.status).toBe(200)
        // A truncated JSON body is the failure being looked for here.
        expect(() => JSON.parse(body)).not.toThrow()
      } finally {
        await proxy.removeToxic('narrow')
      }
    }, 30_000)
  })
})
