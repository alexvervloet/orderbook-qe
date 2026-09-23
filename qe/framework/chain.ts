/**
 * A local chain for tests: spawn Anvil, deploy the exchange, hand back clients.
 *
 * Anvil is started per test file on an ephemeral port rather than shared, so a
 * test can mine, snapshot, revert or reorg without coordinating with anything
 * else. A shared chain turns every onchain test into an ordering problem.
 *
 * Contract artifacts are read from Foundry's output directory, so the tests run
 * against the same bytecode `forge test` did. Re-deriving an ABI by hand is how
 * a suite ends up testing a contract that no longer exists.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'

const here = dirname(fileURLToPath(import.meta.url))
const artifactsDir = resolve(here, '../../sut/contracts/out')

/** Anvil's deterministic development accounts. Not secrets. */
const ANVIL_KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
] as const

export interface Artifact {
  abi: Abi
  bytecode: Hex
}

export function loadArtifact(contract: string, file = `${contract}.sol`): Artifact {
  const path = resolve(artifactsDir, file, `${contract}.json`)
  const json = JSON.parse(readFileSync(path, 'utf8')) as {
    abi: Abi
    bytecode: { object: Hex }
  }
  return { abi: json.abi, bytecode: json.bytecode.object }
}

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer()
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') return fail(new Error('no port'))
      const { port } = address
      server.close(() => done(port))
    })
  })
}

export interface LocalChain {
  readonly rpcUrl: string
  readonly publicClient: PublicClient
  readonly wallets: readonly WalletClient[]
  readonly addresses: readonly Address[]
  deploy(artifact: Artifact, args: readonly unknown[]): Promise<Address>
  /** Mine `count` blocks. */
  mine(count?: number): Promise<void>
  /** Take a chain snapshot that `revert` can return to. */
  snapshot(): Promise<Hex>
  revert(id: Hex): Promise<void>
  stop(): Promise<void>
}

export async function startChain(): Promise<LocalChain> {
  const port = await freePort()
  const anvil: ChildProcess = spawn(
    process.env.ANVIL_BIN ?? `${process.env.HOME}/.foundry/bin/anvil`,
    ['--port', String(port), '--silent', '--accounts', '5'],
    { stdio: 'ignore' },
  )

  const rpcUrl = `http://127.0.0.1:${port}`
  const transport = http(rpcUrl)
  const publicClient = createPublicClient({ chain: foundry, transport }) as PublicClient

  // Anvil takes a moment to bind. Poll rather than sleep a fixed amount, so a
  // slow machine does not produce a flaky suite.
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      await publicClient.getBlockNumber()
      break
    } catch {
      if (Date.now() > deadline) {
        anvil.kill()
        throw new Error('anvil did not start within 10s')
      }
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  const accounts = ANVIL_KEYS.map((key) => privateKeyToAccount(key))
  const wallets = accounts.map(
    (account) => createWalletClient({ account, chain: foundry, transport }) as WalletClient,
  )

  const rpc = async (method: string, params: unknown[] = []): Promise<unknown> => {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    const json = (await response.json()) as { result?: unknown; error?: { message: string } }
    if (json.error !== undefined) throw new Error(`${method}: ${json.error.message}`)
    return json.result
  }

  return {
    rpcUrl,
    publicClient,
    wallets,
    addresses: accounts.map((a) => a.address),
    async deploy(artifact, args) {
      const wallet = wallets[0]!
      const hash = await wallet.deployContract({
        abi: artifact.abi,
        bytecode: artifact.bytecode,
        args: args as never,
        account: wallet.account!,
        chain: foundry,
      })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      const deployed = receipt.contractAddress
      if (deployed === null || deployed === undefined) {
        throw new Error('deployment produced no address')
      }
      return deployed
    },
    async mine(count = 1) {
      await rpc('anvil_mine', [`0x${count.toString(16)}`])
    },
    async snapshot() {
      return (await rpc('evm_snapshot')) as Hex
    },
    async revert(id) {
      await rpc('evm_revert', [id])
    },
    async stop() {
      anvil.kill('SIGKILL')
      await new Promise((r) => setTimeout(r, 20))
    },
  }
}
