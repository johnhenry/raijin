import { describe, it, expect, beforeEach } from 'vitest'
import type { Transaction, Block, Account, TransactionReceipt } from 'raijin-core'
import { TransactionType } from 'raijin-core'
import { RaijinClient, type ClientTransport } from '../src/client.js'

// ── Helpers ──

function makeKey(id: number): Uint8Array {
  const key = new Uint8Array(32)
  key[0] = id
  return key
}

const alice = makeKey(1)
const bob = makeKey(2)

function makeBlock(number: bigint): Block {
  return {
    header: {
      number,
      parentHash: new Uint8Array(32),
      stateRoot: new Uint8Array(32),
      txRoot: new Uint8Array(32),
      receiptRoot: new Uint8Array(32),
      timestamp: Date.now(),
      proposer: alice,
    },
    transactions: [],
    signatures: [],
  }
}

function makeTx(): Transaction {
  return {
    from: alice,
    to: bob,
    value: 100n,
    nonce: 0n,
    data: new Uint8Array([TransactionType.Transfer]),
    signature: new Uint8Array(64),
    chainId: 1n,
  }
}

// ── Mock transport ──

class MockTransport implements ClientTransport {
  #blocks = new Map<string, Block>()
  #accounts = new Map<string, Account>()
  #handlers: ((block: Block) => void)[] = []
  submitted: Transaction[] = []

  addBlock(block: Block): void {
    this.#blocks.set(block.header.number.toString(), block)
  }

  setAccount(address: Uint8Array, account: Account): void {
    const hex = Array.from(address).map(b => b.toString(16).padStart(2, '0')).join('')
    this.#accounts.set(hex, account)
  }

  async submitTransaction(tx: Transaction): Promise<TransactionReceipt> {
    this.submitted.push(tx)
    return {
      txHash: new Uint8Array(32),
      status: 'success',
      index: 0,
    }
  }

  async getAccount(address: Uint8Array): Promise<Account> {
    const hex = Array.from(address).map(b => b.toString(16).padStart(2, '0')).join('')
    return this.#accounts.get(hex) ?? { balance: 0n, nonce: 0n, reputation: 0n }
  }

  async getBlock(number: bigint): Promise<Block | null> {
    return this.#blocks.get(number.toString()) ?? null
  }

  onBlock(handler: (block: Block) => void): () => void {
    this.#handlers.push(handler)
    return () => {
      const idx = this.#handlers.indexOf(handler)
      if (idx >= 0) this.#handlers.splice(idx, 1)
    }
  }

  /** Simulate a new block event. */
  emitBlock(block: Block): void {
    for (const h of this.#handlers) h(block)
  }
}

// ── Tests ──

describe('RaijinClient', () => {
  let transport: MockTransport
  let client: RaijinClient

  beforeEach(() => {
    transport = new MockTransport()
    client = new RaijinClient(transport)
  })

  it('submits a transaction and returns receipt', async () => {
    const tx = makeTx()
    const receipt = await client.submitTransaction(tx)
    expect(receipt.status).toBe('success')
    expect(transport.submitted).toHaveLength(1)
  })

  it('queries an account by address', async () => {
    transport.setAccount(alice, { balance: 500n, nonce: 3n, reputation: 10n })
    const account = await client.getAccount(alice)
    expect(account.balance).toBe(500n)
    expect(account.nonce).toBe(3n)
    expect(account.reputation).toBe(10n)
  })

  it('returns zero account for unknown address', async () => {
    const account = await client.getAccount(makeKey(99))
    expect(account.balance).toBe(0n)
    expect(account.nonce).toBe(0n)
  })

  it('gets a block by height', async () => {
    const block = makeBlock(5n)
    transport.addBlock(block)
    const retrieved = await client.getBlock(5n)
    expect(retrieved).not.toBeNull()
    expect(retrieved!.header.number).toBe(5n)
  })

  it('returns null for missing block', async () => {
    const result = await client.getBlock(999n)
    expect(result).toBeNull()
  })

  it('subscribes to new blocks', () => {
    const blocks: Block[] = []
    const unsub = client.subscribe((block) => blocks.push(block))

    const block1 = makeBlock(1n)
    const block2 = makeBlock(2n)
    transport.emitBlock(block1)
    transport.emitBlock(block2)

    expect(blocks).toHaveLength(2)
    expect(blocks[0].header.number).toBe(1n)
    expect(blocks[1].header.number).toBe(2n)

    unsub()
  })

  it('unsubscribe stops delivering blocks', () => {
    const blocks: Block[] = []
    const unsub = client.subscribe((block) => blocks.push(block))

    transport.emitBlock(makeBlock(1n))
    unsub()
    transport.emitBlock(makeBlock(2n))

    expect(blocks).toHaveLength(1)
  })
})
