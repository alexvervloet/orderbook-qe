/**
 * Deterministic seed data.
 *
 * One definition, used by the container, the load tests and the end-to-end
 * tests. Seeds that live in a setup script and are duplicated in a fixture
 * drift apart, and the drift shows up as a test failure that is really a data
 * problem, which is the most expensive kind to debug.
 *
 * Balances are large enough that no test runs out of funds, and round enough
 * that an unexpected balance is obvious at a glance.
 */
import type { Exchange } from './exchange.ts'

export interface SeedAccount {
  readonly id: string
  readonly base: bigint
  readonly quote: bigint
}

export const SEED_ACCOUNTS: readonly SeedAccount[] = [
  { id: 'maker-1', base: 10n ** 21n, quote: 10n ** 27n },
  { id: 'maker-2', base: 10n ** 21n, quote: 10n ** 27n },
  { id: 'taker-1', base: 10n ** 21n, quote: 10n ** 27n },
  { id: 'taker-2', base: 10n ** 21n, quote: 10n ** 27n },
  // Deliberately poor. A funded-account-only fixture never exercises the
  // insufficient-funds path, which is the one that matters on a real exchange.
  { id: 'broke-1', base: 0n, quote: 0n },
]

export function seedAccounts(exchange: Exchange): void {
  for (const account of SEED_ACCOUNTS) {
    exchange.deposit(account.id, account.base, account.quote)
  }
}
