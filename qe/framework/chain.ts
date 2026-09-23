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

/**
 * Every chain this process started, so none of them outlives it.
 *
 * `stop()` in an `afterAll` is not enough. A test file that throws in
 * `beforeAll`, a worker killed by a timeout, or a run interrupted from the
 * terminal all skip the hook, and the node keeps running with nothing pointing
 * at it. Ten of them accumulated over one session before anyone noticed. See
 * LESSONS.md.
 */
const running = new Set<ChildProcess>()
let exitHooksInstalled = false

function killEveryChain(): void {
  for (const child of running) {
    try {
      child.kill('SIGKILL')
    } catch {
      // Already gone. Nothing to do and nothing worth reporting.
    }
  }
  running.clear()
}

function installExitHooks(): void {
  if (exitHooksInstalled) return
  exitHooksInstalled = true
  process.on('exit', killEveryChain)
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      killEveryChain()
      process.exit(130)
    })
  }
  // An unhandled rejection in a test file kills the worker without running
  // afterAll, which is exactly the case that leaked nodes.
  process.on('uncaughtException', (error) => {
    killEveryChain()
    throw error
  })
}

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
  installExitHooks()
  const port = await freePort()
  const anvil: ChildProcess = spawn(
    process.env.ANVIL_BIN ?? `${process.env.HOME}/.foundry/bin/anvil`,
    ['--port', String(port), '--silent', '--accounts', '5'],
    // `detached: false` keeps the node in this process group, so a group kill
    // takes it with us rather than leaving it behind.
    { stdio: 'ignore', detached: false },
  )
  running.add(anvil)

  const rpcUrl = `http://127.0.0.1:${port}`
  const transport = http(rpcUrl)
  /**
   * Anvil mines instantly, so viem's 4-second default polling interval is
   * dead time: every receipt wait costs one full tick. Fifteen setup
   * transactions came to sixty seconds of a test doing nothing. See LESSONS.md.
   */
  const pollingInterval = Number(process.env.CHAIN_POLL_MS ?? 20)
  const publicClient = createPublicClient({
    chain: foundry,
    transport,
    pollingInterval,
  }) as PublicClient

  // Anvil takes a moment to bind. Poll rather than sleep a fixed amount, so a
  // slow machine does not produce a flaky suite.
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      await publicClient.getBlockNumber()
      break
    } catch {
      if (Date.now() > deadline) {
        anvil.kill('SIGKILL')
        running.delete(anvil)
        throw new Error(
          `anvil did not start within 10s on port ${port}. If the machine is ` +
            'heavily loaded, check for orphaned anvil or test-worker processes.',
        )
      }
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  const accounts = ANVIL_KEYS.map((key) => privateKeyToAccount(key))
  const wallets = accounts.map(
    (account) =>
      createWalletClient({ account, chain: foundry, transport, pollingInterval }) as WalletClient,
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
      running.delete(anvil)
      await new Promise((r) => setTimeout(r, 20))
    },
  }
}
