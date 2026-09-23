/**
 * Toxiproxy control.
 *
 * Puts a controllable proxy between a client and the backend so a test can
 * introduce latency, cut the connection, or throttle the link, and then take it
 * away again.
 *
 * Every condition is declared by the test that needs it rather than configured
 * once in compose. A shared fault configuration means every test runs under
 * conditions chosen for a different test, and the first thing anyone does when
 * one goes red is turn the faults off.
 *
 * The proxy is real and so is the failure: the client sees a socket that stops
 * responding, not a mocked rejection. That distinction is the whole point.
 * Mocking a timeout tests the code path you remembered to write; a real one
 * tests the code path that exists.
 */

export interface ToxicSpec {
  readonly name: string
  readonly type: 'latency' | 'timeout' | 'bandwidth' | 'slow_close' | 'reset_peer'
  /** 'downstream' is server to client; 'upstream' is client to server. */
  readonly stream?: 'upstream' | 'downstream'
  /** 0 to 1. Applies the toxic to this fraction of connections. */
  readonly toxicity?: number
  readonly attributes: Record<string, number>
}

export interface Proxy {
  /** Address a client should connect to, in place of the real backend. */
  readonly listenAddress: string
  addToxic(spec: ToxicSpec): Promise<void>
  removeToxic(name: string): Promise<void>
  /** Drop every established connection immediately. */
  cut(): Promise<void>
  restore(): Promise<void>
  destroy(): Promise<void>
}

export interface ToxiproxyClient {
  createProxy(name: string, listenPort: number, upstream: string): Promise<Proxy>
  reset(): Promise<void>
}

const API = process.env.TOXIPROXY_API ?? 'http://127.0.0.1:8474'

async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok && response.status !== 204) {
    throw new Error(`toxiproxy ${method} ${path}: ${response.status} ${await response.text()}`)
  }
  const text = await response.text()
  return text === '' ? undefined : JSON.parse(text)
}

/** True when a Toxiproxy instance is reachable, so suites can skip cleanly. */
export async function toxiproxyAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${API}/version`, { signal: AbortSignal.timeout(500) })
    return response.ok
  } catch {
    return false
  }
}

export function createToxiproxyClient(): ToxiproxyClient {
  return {
    async createProxy(name, listenPort, upstream) {
      // Remove any leftover from an interrupted run, so a crashed test does not
      // make the next one fail for an unrelated reason.
      await call('DELETE', `/proxies/${name}`).catch(() => undefined)
      await call('POST', '/proxies', {
        name,
        listen: `0.0.0.0:${listenPort}`,
        upstream,
        enabled: true,
      })

      return {
        listenAddress: `127.0.0.1:${listenPort}`,
        async addToxic(spec) {
          await call('POST', `/proxies/${name}/toxics`, {
            name: spec.name,
            type: spec.type,
            stream: spec.stream ?? 'downstream',
            toxicity: spec.toxicity ?? 1,
            attributes: spec.attributes,
          })
        },
        removeToxic: (toxicName) =>
          call('DELETE', `/proxies/${name}/toxics/${toxicName}`).then(() => undefined),
        cut: () => call('POST', `/proxies/${name}`, { enabled: false }).then(() => undefined),
        restore: () => call('POST', `/proxies/${name}`, { enabled: true }).then(() => undefined),
        destroy: () => call('DELETE', `/proxies/${name}`).then(() => undefined),
      }
    },
    reset: () => call('POST', '/reset').then(() => undefined),
  }
}
