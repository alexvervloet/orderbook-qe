/**
 * Reconciliation between offchain records and onchain state.
 *
 * The exchange matches offchain and settles onchain, so there are two records
 * of what happened and they can disagree. Every way they disagree is serious,
 * and most of them are silent: the services stay up, the API returns 200, and
 * the dashboards stay green while the two ledgers drift apart.
 *
 * A reconciler is the only thing that finds that class of problem, so it is
 * test equipment and production tooling at the same time. This one is written
 * to report every difference rather than throwing on the first, because
 * "balances disagree for one account" and "balances disagree for every account"
 * have very different causes and you want to know which you are looking at.
 */
import type { Address } from 'viem'
import type { Ledger } from '../../sut/backend/ledger.ts'
import type { OnchainExchange } from './onchain-exchange.ts'

export interface Divergence {
  readonly account: string
  readonly field: 'base' | 'quote'
  readonly offchain: bigint
  readonly onchain: bigint
}

export interface ReconciliationReport {
  readonly agreed: boolean
  readonly divergences: readonly Divergence[]
  /** Net difference per asset, summed across accounts. */
  readonly netBase: bigint
  readonly netQuote: bigint
}

export function describeReport(report: ReconciliationReport): string {
  if (report.agreed) return 'offchain and onchain agree'
  const lines = report.divergences.map(
    (d) =>
      `  ${d.account} ${d.field}: offchain ${d.offchain}, onchain ${d.onchain}, ` +
      `difference ${d.offchain - d.onchain}`,
  )
  return [
    `${report.divergences.length} divergence(s)`,
    ...lines,
    `  net base ${report.netBase}, net quote ${report.netQuote}`,
  ].join('\n')
}

/**
 * Compare an offchain ledger against the deployed contract.
 *
 * Onchain a trader's holdings are split between available and escrowed, and
 * offchain nothing is escrowed, so the comparison is against the sum. Comparing
 * only the available balance would report a divergence for every resting order.
 */
export async function reconcile(
  ledger: Ledger,
  onchain: OnchainExchange,
  accounts: readonly { readonly offchainId: string; readonly address: Address }[],
): Promise<ReconciliationReport> {
  const divergences: Divergence[] = []
  let netBase = 0n
  let netQuote = 0n

  for (const account of accounts) {
    const onchainBase =
      (await onchain.availableBase(account.address)) + (await onchain.lockedBase(account.address))
    const onchainQuote =
      (await onchain.availableQuote(account.address)) + (await onchain.lockedQuote(account.address))
    const offchainBase = ledger.baseOf(account.offchainId)
    const offchainQuote = ledger.quoteOf(account.offchainId)

    if (offchainBase !== onchainBase) {
      divergences.push({
        account: account.offchainId,
        field: 'base',
        offchain: offchainBase,
        onchain: onchainBase,
      })
    }
    if (offchainQuote !== onchainQuote) {
      divergences.push({
        account: account.offchainId,
        field: 'quote',
        offchain: offchainQuote,
        onchain: onchainQuote,
      })
    }
    netBase += offchainBase - onchainBase
    netQuote += offchainQuote - onchainQuote
  }

  return { agreed: divergences.length === 0, divergences, netBase, netQuote }
}
