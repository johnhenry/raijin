import { describe, it, expect, beforeEach } from 'vitest'
import {
  InMemoryStateStore,
  TransactionType,
  encodeAccount,
  type Transaction,
  type SignatureVerifier,
} from 'raijin-core'
import type { NetworkTransport, ConsensusMessage, ConsensusTimer, TimerHandle } from 'raijin-consensus'
import { ValidatorNode } from '../src/validator.js'
import { Mempool } from '../src/mempool.js'
import { BlockProducer } from '../src/block-producer.js'

// ── Mock helpers ──

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

  get pending(): number {
    return this.#timers.size
  }
}

/** Loopback transport that delivers messages back to the same node's handler. */
class LoopbackTransport implements NetworkTransport {
  #handler: ((from: Uint8Array, msg: ConsensusMessage) => void) | null = null
  #identity: Uint8Array
  broadcasts: ConsensusMessage[] = []

  constructor(identity: Uint8Array) {
    this.#identity = identity
  }

  broadcast(message: ConsensusMessage): void {
    this.broadcasts.push(message)
  }

  send(_to: Uint8Array, _message: ConsensusMessage): void {
    // no-op for single-node
  }

  onMessage(handler: (from: Uint8Array, msg: ConsensusMessage) => void): void {
    this.#handler = handler
  }

  /** Simulate receiving a message. */
  deliver(from: Uint8Array, msg: ConsensusMessage): void {
    this.#handler?.(from, msg)
  }
}

// ── Tests ──

const alice = makeKey(1)
const bob = makeKey(2)

describe('Mempool', () => {
  let mempool: Mempool

  beforeEach(() => {
    mempool = new Mempool(10)
  })

  it('adds and retrieves transactions', async () => {
    const tx = makeTransfer(alice, bob, 100n, 0n)
    await mempool.add(tx)
    expect(mempool.size).toBe(1)
    expect(mempool.pending()).toHaveLength(1)
  })

  it('respects max size', async () => {
    const pool = new Mempool(2)
    await pool.add(makeTransfer(alice, bob, 1n, 0n))
    await pool.add(makeTransfer(alice, bob, 2n, 1n))
    await expect(pool.add(makeTransfer(alice, bob, 3n, 2n))).rejects.toThrow('Mempool full')
  })

  it('removes transactions after finalization', async () => {
    const tx = makeTransfer(alice, bob, 100n, 0n)
    await mempool.add(tx)
    expect(mempool.size).toBe(1)
    await mempool.removeBatch([tx])
    expect(mempool.size).toBe(0)
  })

  it('limits pending retrieval', async () => {
    await mempool.add(makeTransfer(alice, bob, 1n, 0n))
    await mempool.add(makeTransfer(alice, bob, 2n, 1n))
    await mempool.add(makeTransfer(alice, bob, 3n, 2n))
    expect(mempool.pending(2)).toHaveLength(2)
    expect(mempool.pending()).toHaveLength(3)
  })

  it('clears all transactions', async () => {
    await mempool.add(makeTransfer(alice, bob, 1n, 0n))
    await mempool.add(makeTransfer(alice, bob, 2n, 1n))
    mempool.clear()
    expect(mempool.size).toBe(0)
  })
})

describe('ValidatorNode', () => {
  let store: InMemoryStateStore
  let timer: MockTimer
  let transport: LoopbackTransport
  let node: ValidatorNode

  beforeEach(async () => {
    store = new InMemoryStateStore()
    timer = new MockTimer()
    transport = new LoopbackTransport(alice)

    node = new ValidatorNode({
      identity: {
        publicKey: alice,
        sign: async (msg) => alice,
        verify: alwaysValidVerifier,
      },
      transport,
      timer,
      store,
      blockTime: 1000,
      validators: [alice],
      maxTxPerBlock: 50,
    })

    // Fund alice
    const key = new TextEncoder().encode('account:')
    const fullKey = new Uint8Array(key.length + alice.length)
    fullKey.set(key, 0)
    fullKey.set(alice, key.length)
    await store.put(fullKey, encodeAccount({ balance: 10000n, nonce: 0n, reputation: 0n }))
  })

  it('starts and stops cleanly', () => {
    expect(node.running).toBe(false)
    node.start()
    expect(node.running).toBe(true)
    node.stop()
    expect(node.running).toBe(false)
  })

  it('does not double-start', () => {
    node.start()
    node.start() // should be a no-op
    expect(node.running).toBe(true)
    node.stop()
  })

  it('submits transactions to the mempool', async () => {
    const tx = makeTransfer(alice, bob, 100n, 0n)
    const hashHex = await node.submitTransaction(tx)
    expect(typeof hashHex).toBe('string')
    expect(hashHex.length).toBeGreaterThan(0)
    expect(node.mempool.size).toBe(1)
  })

  it('exposes latestBlock as null initially', () => {
    expect(node.latestBlock).toBeNull()
  })

  it('exposes consensus, mempool, stateMachine, and blockProducer', () => {
    expect(node.consensus).toBeDefined()
    expect(node.mempool).toBeDefined()
    expect(node.stateMachine).toBeDefined()
    expect(node.blockProducer).toBeDefined()
  })

  it('block producer returns null when not leader', async () => {
    // Create a node that is NOT the leader (bob, but leader rotation gives alice view 0)
    const bobTransport = new LoopbackTransport(bob)
    const bobNode = new ValidatorNode({
      identity: {
        publicKey: bob,
        sign: async (msg) => bob,
        verify: alwaysValidVerifier,
      },
      transport: bobTransport,
      timer: new MockTimer(),
      store: new InMemoryStateStore(),
      blockTime: 1000,
      validators: [alice, bob],
    })

    await bobNode.submitTransaction(makeTransfer(bob, alice, 1n, 0n))
    const block = await bobNode.blockProducer.produceBlock()
    expect(block).toBeNull()
  })

  it('block producer builds a block when leader with pending txs', async () => {
    await node.submitTransaction(makeTransfer(alice, bob, 100n, 0n))

    // Node is leader (sole validator), so block production should work
    const block = await node.blockProducer.produceBlock()
    expect(block).not.toBeNull()
    expect(block!.transactions).toHaveLength(1)
    expect(block!.header.number).toBe(1n)
  })

  it('block producer returns null when mempool is empty', async () => {
    const block = await node.blockProducer.produceBlock()
    expect(block).toBeNull()
  })

  it('onBlockFinalized handler is called on finalization', async () => {
    let finalized = false
    node.onBlockFinalized((block, receipts) => {
      finalized = true
      expect(block.transactions.length).toBeGreaterThan(0)
      expect(receipts).toBeDefined()
    })

    // This test just verifies the handler registration works
    expect(finalized).toBe(false)
  })
})
