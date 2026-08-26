import { describe, it, expect, beforeEach } from 'vitest'
import {
  InMemoryStateStore,
  TransactionType,
  encodeAccount,
  encodeTxSigned,
  hash,
  merkleRoot,
  equal,
  type Transaction,
  type SignatureVerifier,
  type Block,
  type TransactionReceipt,
} from '@johnhenry/raijin-core'
import type { NetworkTransport, ConsensusMessage, ConsensusTimer, TimerHandle } from '@johnhenry/raijin-consensus'
import { ValidatorNode } from '../src/validator.js'

// ── Mock helpers (mirrors validator.test.ts) ──

const alwaysValidVerifier: SignatureVerifier = {
  async verify() { return true },
}

function makeKey(id: number): Uint8Array {
  const key = new Uint8Array(32)
  key[0] = id
  return key
}

function makeTransfer(from: Uint8Array, to: Uint8Array, value: bigint, nonce: bigint): Transaction {
  return {
    from,
    to,
    value,
    nonce,
    data: new Uint8Array([TransactionType.Transfer]),
    signature: new Uint8Array(64),
    chainId: 1n,
  }
}

class MockTimer implements ConsensusTimer {
  #timers = new Map<number, { ms: number; callback: () => void; scheduledAt: number }>()
  #nextId = 1
  #now = 0

  set(ms: number, callback: () => void): TimerHandle {
    const id = this.#nextId++
    this.#timers.set(id, { ms, callback, scheduledAt: this.#now })
    return id
  }

  clear(handle: TimerHandle): void {
    this.#timers.delete(handle as number)
  }

  advance(ms: number): void {
    this.#now += ms
    const expired: (() => void)[] = []
    for (const [id, timer] of this.#timers) {
      if (this.#now - timer.scheduledAt >= timer.ms) {
        expired.push(timer.callback)
        this.#timers.delete(id)
      }
    }
    for (const cb of expired) cb()
  }
}

class LoopbackTransport implements NetworkTransport {
  #handler: ((from: Uint8Array, msg: ConsensusMessage) => void) | null = null

  broadcast(_message: ConsensusMessage): void {}
  send(_to: Uint8Array, _message: ConsensusMessage): void {}
  onMessage(handler: (from: Uint8Array, msg: ConsensusMessage) => void): void {
    this.#handler = handler
  }
}

const alice = makeKey(1)
const bob = makeKey(2)

async function fundAccount(store: InMemoryStateStore, address: Uint8Array, balance: bigint): Promise<void> {
  const prefix = new TextEncoder().encode('account:')
  const key = new Uint8Array(prefix.length + address.length)
  key.set(prefix, 0)
  key.set(address, prefix.length)
  await store.put(key, encodeAccount({ balance, nonce: 0n, reputation: 0n }))
}

describe('BlockProducer / ValidatorNode — receipt & chain-linkage integrity', () => {
  let store: InMemoryStateStore
  let node: ValidatorNode

  beforeEach(async () => {
    store = new InMemoryStateStore()
    node = new ValidatorNode({
      identity: {
        publicKey: alice,
        sign: async () => alice,
        verify: alwaysValidVerifier,
      },
      transport: new LoopbackTransport(),
      timer: new MockTimer(),
      store,
      blockTime: 1000,
      validators: [alice], // sole validator — quorum 1, finalizes immediately
    })
    await fundAccount(store, alice, 10_000n)
  })

  async function produceAndFinalize(tx: Transaction): Promise<{ block: Block; receipts: TransactionReceipt[] }> {
    const finalized = new Promise<{ block: Block; receipts: TransactionReceipt[] }>((resolve) => {
      node.onBlockFinalized((block, receipts) => resolve({ block, receipts }))
    })
    await node.submitTransaction(tx)
    await node.blockProducer.produceBlock()
    return finalized
  }

  it("a transaction's receipt txHash matches its txRoot leaf hash", async () => {
    const tx = makeTransfer(alice, bob, 100n, 0n)
    const { block, receipts } = await produceAndFinalize(tx)

    expect(receipts).toHaveLength(1)
    const receipt = receipts[0]

    // Canonical tx identifier used everywhere: hash of the SIGNED encoding.
    const expectedHash = await hash(encodeTxSigned(tx))
    expect(equal(receipt.txHash, expectedHash)).toBe(true)

    // The block's txRoot must be a Merkle root over leaves that include
    // this same hash — i.e. the receipt's txHash actually identifies a
    // leaf of block.header.txRoot, not some other encoding.
    const leaves = await Promise.all(block.transactions.map((t) => hash(encodeTxSigned(t))))
    expect(leaves.some((leaf) => equal(leaf, receipt.txHash))).toBe(true)
    const recomputedTxRoot = await merkleRoot(leaves)
    expect(equal(recomputedTxRoot, block.header.txRoot)).toBe(true)
  })

  it('chains parentHash to the previous block real (non-zero) stateRoot', async () => {
    const tx1 = makeTransfer(alice, bob, 100n, 0n)
    const { block: block1 } = await produceAndFinalize(tx1)

    expect(block1.header.stateRoot).not.toEqual(new Uint8Array(32))

    const tx2 = makeTransfer(alice, bob, 50n, 1n)
    const { block: block2 } = await produceAndFinalize(tx2)

    expect(equal(block2.header.parentHash, block1.header.stateRoot)).toBe(true)
  })
})
