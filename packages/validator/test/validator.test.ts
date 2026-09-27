import { describe, it, expect, beforeEach } from 'vitest'
import {
  InMemoryStateStore,
  TransactionType,
  accountKey,
  encodeAccount,
  type Transaction,
  type SignatureVerifier,
} from '@johnhenry/raijin-core'
import type { NetworkTransport, ConsensusMessage, ConsensusTimer, TimerHandle } from '@johnhenry/raijin-consensus'
import { Mempool } from '@johnhenry/raijin-mempool'
import { ValidatorNode } from '../src/validator.js'
import { BlockProducer } from '../src/block-producer.js'

// ── Mock helpers ──

const alwaysValidVerifier: SignatureVerifier = {
  async verify() { return true },
}

const alwaysInvalidVerifier: SignatureVerifier = {
  async verify() { return false },
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

// The naive, unvalidated per-package Mempool (packages/validator/src/mempool.ts)
// has been removed — ValidatorNode now uses the real, signature-verified,
// fee-ordered @johnhenry/raijin-mempool package directly (see validator.ts).
// Its own extensive test suite lives in packages/mempool/test/mempool.test.ts;
// these are just a couple of smoke tests confirming the package's actual API.
describe('Mempool (@johnhenry/raijin-mempool)', () => {
  let mempool: Mempool

  beforeEach(() => {
    mempool = new Mempool({ maxSize: 10, verifier: async () => true })
  })

  it('adds and retrieves transactions', async () => {
    const tx = makeTransfer(alice, bob, 100n, 0n)
    await mempool.submit(tx)
    expect(mempool.size).toBe(1)
    expect(mempool.pending()).toHaveLength(1)
  })

  it('rejects a tx when full and no lower-fee tx to evict', async () => {
    const pool = new Mempool({ maxSize: 2, verifier: async () => true })
    await pool.submit(makeTransfer(alice, bob, 1n, 0n))
    await pool.submit(makeTransfer(alice, bob, 2n, 1n))
    // All these txs have the default (zero) fee, so the third can't evict either of the first two.
    const accepted = await pool.submit(makeTransfer(alice, bob, 3n, 2n))
    expect(accepted).toBe(false)
    expect(pool.size).toBe(2)
  })

  it('removes transactions after finalization', async () => {
    const tx = makeTransfer(alice, bob, 100n, 0n)
    await mempool.submit(tx)
    expect(mempool.size).toBe(1)
    mempool.removeBatch([tx])
    expect(mempool.size).toBe(0)
  })

  it('limits pendingForProposer retrieval', async () => {
    await mempool.submit(makeTransfer(alice, bob, 1n, 0n))
    await mempool.submit(makeTransfer(alice, bob, 2n, 1n))
    await mempool.submit(makeTransfer(alice, bob, 3n, 2n))
    expect(mempool.pendingForProposer(2)).toHaveLength(2)
    expect(mempool.pending()).toHaveLength(3)
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
      chainId: 1n,
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
    await store.put(accountKey(alice), encodeAccount({ balance: 10000n, nonce: 0n, reputation: 0n }))
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

  it('rejects a transaction with a bad signature before it enters the mempool', async () => {
    const badNode = new ValidatorNode({
      chainId: 1n,
      identity: {
        publicKey: alice,
        sign: async () => alice,
        verify: alwaysInvalidVerifier, // every signature check fails
      },
      transport: new LoopbackTransport(alice),
      timer: new MockTimer(),
      store: new InMemoryStateStore(),
      blockTime: 1000,
      validators: [alice],
    })

    const tx = makeTransfer(alice, bob, 100n, 0n)
    await expect(badNode.submitTransaction(tx)).rejects.toThrow()
    expect(badNode.mempool.size).toBe(0)
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
      chainId: 1n,
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
    const finalized = new Promise<{ block: any; receipts: any }>((resolve) => {
      node.onBlockFinalized((block, receipts) => {
        resolve({ block, receipts })
      })
    })

    await node.submitTransaction(makeTransfer(alice, bob, 100n, 0n))
    await node.blockProducer.produceBlock()

    // Single-validator PBFT finalizes via microtask after propose() returns
    const { block, receipts } = await finalized
    expect(block.transactions.length).toBeGreaterThan(0)
    expect(receipts).toBeDefined()
    expect(receipts).toHaveLength(1)
  })

  // Issue #47's smaller gaps: importSyncState used to leave already-included
  // transactions sitting in the mempool, and exportSyncState was synchronous
  // (so it couldn't wait for an in-progress applyBlock before reading the
  // store).
  describe('sync state import/export (issue #47)', () => {
    it('importSyncState removes the synced block\'s transactions from the mempool', async () => {
      const tx = makeTransfer(alice, bob, 100n, 0n)
      await node.submitTransaction(tx)
      expect(node.mempool.has(tx)).toBe(true)

      await node.importSyncState({
        storeData: store.exportData(),
        latestBlock: {
          header: {
            number: 1n,
            parentHash: new Uint8Array(32),
            stateRoot: new Uint8Array(32),
            txRoot: new Uint8Array(32),
            receiptRoot: new Uint8Array(32),
            timestamp: Date.now(),
            proposer: alice,
          },
          transactions: [tx],
          signatures: [],
        },
        consensus: {
          view: 0n,
          viewChangeJustification: [],
          sequence: 1n,
          prePrepare: null,
          prepares: [],
          commits: [],
        },
      })

      // The synced state already reflects this tx having been applied --
      // it must not still be sitting in the mempool, waiting to be
      // (incorrectly) re-included in a future block.
      expect(node.mempool.has(tx)).toBe(false)
      expect(node.mempool.size).toBe(0)
    })

    it('exportSyncState resolves to the current state (now async, per issue #47)', async () => {
      const finalized = new Promise<void>((resolve) => {
        node.onBlockFinalized(() => resolve())
      })
      await node.submitTransaction(makeTransfer(alice, bob, 100n, 0n))
      await node.blockProducer.produceBlock()
      await finalized

      const exported = await node.exportSyncState()
      expect(exported.storeData).toBeInstanceOf(Map)
      expect(exported.latestBlock).not.toBeNull()
      expect(exported.consensus).toBeDefined()
    })
  })

  // Two further gaps found in raijin-validator 0.0.4 (issue #51).
  describe('sync state import/export (issue #51)', () => {
    it('importSyncState prunes every pending tx already consumed on-chain, not just the latest block\'s own transactions', async () => {
      // Alice has four transactions pending in this node's mempool.
      const tx0 = makeTransfer(alice, bob, 10n, 0n)
      const tx1 = makeTransfer(alice, bob, 10n, 1n)
      const tx2 = makeTransfer(alice, bob, 10n, 2n)
      const tx3 = makeTransfer(alice, bob, 10n, 3n) // not yet included anywhere
      for (const tx of [tx0, tx1, tx2, tx3]) await node.submitTransaction(tx)
      expect(node.mempool.size).toBe(4)

      // The peer being synced from has already applied all of nonces 0-2 --
      // across THREE separate blocks this node never saw individually, only
      // the last of which ("latestBlock") is part of the snapshot. Its
      // account nonce for alice is now 3.
      const syncedStore = new InMemoryStateStore()
      await syncedStore.put(accountKey(alice), encodeAccount({ balance: 9970n, nonce: 3n, reputation: 0n }))

      await node.importSyncState({
        storeData: syncedStore.exportData(),
        latestBlock: {
          header: {
            number: 3n,
            parentHash: new Uint8Array(32),
            stateRoot: new Uint8Array(32),
            txRoot: new Uint8Array(32),
            receiptRoot: new Uint8Array(32),
            timestamp: Date.now(),
            proposer: alice,
          },
          // Only the LATEST block's own transaction is named -- blocks 1
          // and 2 (which consumed nonces 0 and 1) are unknown to this
          // snapshot, exactly as in the issue's repro (194 of 196 pending
          // txs survived an import there for this reason).
          transactions: [tx2],
          signatures: [],
        },
        consensus: {
          view: 0n,
          viewChangeJustification: [],
          sequence: 3n,
          prePrepare: null,
          prepares: [],
          commits: [],
        },
      })

      // Before raijin#51's fix, only tx2 (named by latestBlock) would have
      // been pruned -- tx0 and tx1 (consumed by earlier, unseen blocks)
      // would still be sitting in the mempool, stale forever.
      expect(node.mempool.has(tx0), 'nonce 0, already consumed').toBe(false)
      expect(node.mempool.has(tx1), 'nonce 1, already consumed').toBe(false)
      expect(node.mempool.has(tx2), 'nonce 2, named by latestBlock').toBe(false)
      // Nonce 3 has NOT been consumed yet -- it must survive the prune.
      expect(node.mempool.has(tx3), 'nonce 3, not yet included').toBe(true)
      expect(node.mempool.size).toBe(1)
    })

    it('exportSyncState never returns a store that is ahead of latestBlock, even when the finalize notification is delayed', async () => {
      // Delay `stateRoot()` -- the step in the consensus engine's
      // post-`applyBlock` finalize sequence that runs AFTER the store is
      // fully mutated but BEFORE `latestBlock` is updated (via the
      // `onBlockFinalized` notification `ValidatorNode` uses to advance it).
      // Before raijin#51, `whenIdle` only tracked the `applyBlock` promise
      // itself, so a racing `exportSyncState` could resume in exactly this
      // window: the store already reflects the new block, `latestBlock`
      // still names the old one -- 25 of 25 reproductions in the issue.
      const originalStateRoot = node.stateMachine.stateRoot.bind(node.stateMachine)
      let release: (() => void) | null = null
      const held = new Promise<void>((resolve) => { release = resolve })
      node.stateMachine.stateRoot = () => held.then(() => originalStateRoot())

      await node.submitTransaction(makeTransfer(alice, bob, 100n, 0n))
      const producePromise = node.blockProducer.produceBlock()

      // Let the round get all the way past `applyBlock` and get stuck on
      // the patched `stateRoot()`.
      for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))

      let exported: Awaited<ReturnType<ValidatorNode['exportSyncState']>> | null = null
      const exportPromise = node.exportSyncState().then((r) => { exported = r })
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
      expect(exported, 'exportSyncState resolved before the block finished finalizing').toBeNull()

      release!()
      await producePromise
      await exportPromise

      expect(exported).not.toBeNull()
      expect(exported!.latestBlock, 'latestBlock must already reflect the block whose state the store export carries').not.toBeNull()
      expect(exported!.latestBlock!.header.number).toBe(1n)
    })
  })
})
