/**
 * Container entry point.
 *
 * Seeds a set of funded accounts when SEED_ACCOUNTS is set, so a fresh
 * environment is usable immediately rather than requiring a setup script that
 * drifts from what the tests assume. Test data lives in one place; see
 * docs/TEST-DATA.md.
 */
import { buildServer, DEFAULT_MARKET } from './server.ts'
import { Exchange } from './exchange.ts'
import { SEED_ACCOUNTS, seedAccounts } from './seed.ts'

const port = Number(process.env.PORT ?? 8080)
const host = process.env.HOST ?? '0.0.0.0'

const exchange = new Exchange(DEFAULT_MARKET)
if (process.env.SEED_ACCOUNTS !== '0') {
  seedAccounts(exchange)
  console.log(`seeded ${SEED_ACCOUNTS.length} accounts`)
}

const app = await buildServer({ exchange })
await app.listen({ port, host })
console.log(`exchange listening on ${host}:${port}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0))
  })
}
