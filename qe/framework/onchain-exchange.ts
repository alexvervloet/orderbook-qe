/**
 * Typed wrapper around the deployed exchange, plus a fixture that stands it up
 * with funded traders.
 *
 * The wrapper exists so a consistency test reads as a sequence of trading
 * actions rather than a sequence of RPC calls. A test that has to think about
 * receipts is a test nobody will extend.
 */
import type { Address } from 'viem'
import { loadArtifact, startChain, type LocalChain } from './chain.ts'

export const ONCHAIN_MARKET = {
  quoteScale: 10_000n,
  baseScale: 1_000_000n,
  makerFeeBps: 2n,
  takerFeeBps: 7n,
} as const

export interface OnchainExchange {
  readonly chain: LocalChain
  readonly address: Address
  readonly feeRecipient: Address
  readonly traders: readonly Address[]
  placeLimitOrder(
    trader: number,
    isBuy: boolean,
    price: bigint,
    quantity: bigint,
  ): Promise<{ orderId: bigint; reverted: string | null }>
  cancelOrder(trader: number, orderId: bigint): Promise<string | null>
  availableBase(who: Address): Promise<bigint>
  availableQuote(who: Address): Promise<bigint>
  lockedBase(who: Address): Promise<bigint>
  lockedQuote(who: Address): Promise<bigint>
  bestPrice(isBuy: boolean): Promise<bigint>
  levelAt(isBuy: boolean, price: bigint): Promise<{ quantity: bigint; exists: boolean }>
  /** Visible depth per side, best price first, walked from the level list. */
  depth(isBuy: boolean): Promise<{ price: bigint; quantity: bigint }[]>
  stop(): Promise<void>
}

const FEE_RECIPIENT = '0x0000000000000000000000000000000000000FEE' as Address

export interface MarketParams {
  readonly quoteScale: bigint
  readonly baseScale: bigint
  readonly makerFeeBps: bigint
  readonly takerFeeBps: bigint
}

export async function deployExchange(
  fundEach = 10n ** 24n,
  market: MarketParams = ONCHAIN_MARKET,
): Promise<OnchainExchange> {
  const chain = await startChain()
  const erc20 = loadArtifact('MockERC20')
  const exchangeArtifact = loadArtifact('OrderBookExchange')

  const base = await chain.deploy(erc20, [])
  const quote = await chain.deploy(erc20, [])
  const address = await chain.deploy(exchangeArtifact, [
    base,
    quote,
    market.quoteScale,
    market.baseScale,
    market.makerFeeBps,
    market.takerFeeBps,
    FEE_RECIPIENT,
  ])

  const traders = chain.addresses
  const quoteFunding = fundEach * 10n ** 6n

  const write = async (
    index: number,
    to: Address,
    abi: typeof erc20.abi | typeof exchangeArtifact.abi,
    functionName: string,
    args: readonly unknown[],
  ): Promise<string | null> => {
    const wallet = chain.wallets[index]!
    try {
      const hash = await wallet.writeContract({
        address: to,
        abi,
        functionName,
        args: args as never,
        account: wallet.account!,
        chain: wallet.chain!,
      })
      const receipt = await chain.publicClient.waitForTransactionReceipt({ hash })
      return receipt.status === 'success' ? null : 'reverted'
    } catch (error) {
      // A revert is an expected outcome for a refused order, not a test error.
      const message = error instanceof Error ? error.message : String(error)
      const named = /Error: (\w+)\(\)/.exec(message)
      return named?.[1] ?? 'reverted'
    }
  }

  /**
   * Setup must not fail quietly.
   *
   * The `write` helper returns a revert reason instead of throwing, which is
   * right for a test placing an order that is meant to be refused and wrong for
   * fixture setup. When the funding transactions failed silently under parallel
   * workers, every trader had a zero balance, every order reverted, and the
   * tests reported the contract disagreeing with the engine. The real fault was
   * two directories away. See LESSONS.md.
   */
  const mustSucceed = async (
    index: number,
    to: Address,
    abi: typeof erc20.abi | typeof exchangeArtifact.abi,
    functionName: string,
    args: readonly unknown[],
  ): Promise<void> => {
    const failure = await write(index, to, abi, functionName, args)
    if (failure !== null) {
      throw new Error(
        `fixture setup failed: ${functionName} for trader ${index} reverted with ${failure}. ` +
          'Every test in this file would otherwise run against unfunded accounts.',
      )
    }
  }

  for (const [index, trader] of traders.entries()) {
    await mustSucceed(index, base, erc20.abi, 'mint', [trader, fundEach])
    await mustSucceed(index, quote, erc20.abi, 'mint', [trader, quoteFunding])
    await mustSucceed(index, address, exchangeArtifact.abi, 'depositBase', [fundEach])
    await mustSucceed(index, address, exchangeArtifact.abi, 'depositQuote', [quoteFunding])
  }

  // Prove the fixture is actually usable before handing it to a test.
  for (const [index, trader] of traders.entries()) {
    const deposited = (await chain.publicClient.readContract({
      address,
      abi: exchangeArtifact.abi,
      functionName: 'availableBase',
      args: [trader],
    })) as bigint
    if (deposited !== fundEach) {
      throw new Error(
        `fixture setup is wrong: trader ${index} has ${deposited} base, expected ${fundEach}`,
      )
    }
  }

  const read = async <T>(functionName: string, args: readonly unknown[] = []): Promise<T> =>
    (await chain.publicClient.readContract({
      address,
      abi: exchangeArtifact.abi,
      functionName,
      args: args as never,
    })) as T

  return {
    chain,
    address,
    feeRecipient: FEE_RECIPIENT,
    traders,
    async placeLimitOrder(trader, isBuy, price, quantity) {
      const before = await read<bigint>('nextOrderId')
      const reverted = await write(trader, address, exchangeArtifact.abi, 'placeLimitOrder', [
        isBuy,
        price,
        quantity,
      ])
      if (reverted !== null) return { orderId: 0n, reverted }
      const after = await read<bigint>('nextOrderId')
      // The id only advances when the order actually rested.
      return { orderId: after > before ? before : 0n, reverted: null }
    },
    cancelOrder: (trader, orderId) =>
      write(trader, address, exchangeArtifact.abi, 'cancelOrder', [orderId]),
    availableBase: (who) => read<bigint>('availableBase', [who]),
    availableQuote: (who) => read<bigint>('availableQuote', [who]),
    lockedBase: (who) => read<bigint>('lockedBase', [who]),
    lockedQuote: (who) => read<bigint>('lockedQuote', [who]),
    bestPrice: (isBuy) => read<bigint>('bestPrice', [isBuy]),
    async levelAt(isBuy, price) {
      const [quantity, , exists] = await read<[bigint, bigint, boolean]>('levelAt', [isBuy, price])
      return { quantity, exists }
    },
    async depth(isBuy) {
      const out: { price: bigint; quantity: bigint }[] = []
      let price = await read<bigint>('bestPrice', [isBuy])
      let steps = 0
      while (price !== 0n && steps < 64) {
        const [quantity] = await read<[bigint, bigint, boolean]>('levelAt', [isBuy, price])
        out.push({ price, quantity })
        price = await read<bigint>('nextWorsePrice', [isBuy, price])
        steps++
      }
      return out
    },
    stop: () => chain.stop(),
  }
}
