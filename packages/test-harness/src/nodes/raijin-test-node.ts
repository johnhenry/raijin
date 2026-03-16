/**
 * RaijinTestNode — wraps a real ValidatorNode for deterministic testing.
 */

import {
  InMemoryStateStore,
  TransactionType,
  encodeAccount,
  toHex,
  type Transaction,
  type StateStore,
  type Block,
} from 'raijin-core'
import type { ConsensusTimer, NetworkTransport } from 'raijin-consensus'
import { ValidatorNode } from 'raijin-validator'

const encoder = new TextEncoder()

export interface RaijinTestNodeConfig {
  /** Unique string ID for this node (for orchestrator bookkeeping). */
  id: string
  /** 32-byte public key for this validator. */
  publicKey: Uint8Array
  /** Sign function (from mockSign). */
  sign: (message: Uint8Array) => Promise<Uint8Array>
  /** Signature verifier (from mockVerifier). */
  verify: { verify(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): Promise<boolean> }
  /** Network transport (from DeterministicNetwork.createTransport). */
  transport: NetworkTransport
  /** Shared MockTimer. */
  timer: ConsensusTimer
  /** All validator public keys. */
  validators: Uint8Array[]
  /** Block time in ms. Default: 2000. */
  blockTime?: number
}

export class RaijinTestNode {
  readonly id: string
  readonly publicKey: Uint8Array
  readonly store: InMemoryStateStore
  readonly node: ValidatorNode

  #running = false
  #finalizedBlocks: Block[] = []

  constructor(config: RaijinTestNodeConfig) {
    this.id = config.id
    this.publicKey = config.publicKey
    this.store = new InMemoryStateStore()

    this.node = new ValidatorNode({
      identity: {
        publicKey: config.publicKey,
        sign: config.sign,
        verify: config.verify,
      },
      transport: config.transport,
      timer: config.timer,
      store: this.store,
      validators: config.validators,
      blockTime: config.blockTime ?? 2000,
    })

    this.node.onBlockFinalized((block) => {
      this.#finalizedBlocks.push(block)
    })
  }

  /** Start the validator node. */
  start(): void {
    if (this.#running) return
    this.#running = true
    this.node.start()
  }

  /** Stop the validator node gracefully. */
  stop(): void {
    if (!this.#running) return
    this.#running = false
    this.node.stop()
  }

  /** Crash the node (stop + disconnect handled externally). */
  crash(): void {
    this.stop()
  }

  /** Whether the node is running. */
  get running(): boolean {
    return this.#running
  }

  /** All blocks finalized by this node. */
  get finalizedBlocks(): Block[] {
    return this.#finalizedBlocks
  }

  /** The latest finalized block, or null. */
  get latestBlock(): Block | null {
    return this.node.latestBlock
  }

  /**
   * Fund an account by writing directly to the InMemoryStateStore.
   * This bypasses the state machine — use for test setup only.
   */
  async fund(account: Uint8Array, amount: bigint): Promise<void> {
    // Read existing account to preserve nonce/reputation, then add to balance
    const existing = await this.node.stateMachine.getAccount(account)
    const prefix = encoder.encode('account:')
    const key = new Uint8Array(prefix.length + account.length)
    key.set(prefix, 0)
    key.set(account, prefix.length)
    await this.store.put(key, encodeAccount({
      balance: existing.balance + amount,
      nonce: existing.nonce,
      reputation: existing.reputation,
    }))
  }

  /**
   * Submit a transfer transaction to this node's mempool.
   */
  async submitTx(from: Uint8Array, to: Uint8Array, amount: bigint, nonce = 0n): Promise<string> {
    const tx: Transaction = {
      from,
      to,
      value: amount,
      nonce,
      data: new Uint8Array([TransactionType.Transfer]),
      signature: new Uint8Array(64),
      chainId: 1n,
    }
    return this.node.submitTransaction(tx)
  }

  /**
   * Propose a block (only works if this node is the current leader).
   */
  async proposeBlock(): Promise<Block | null> {
    return this.node.blockProducer.produceBlock()
  }

  /**
   * Take a snapshot of this node's state for comparison.
   */
  async snapshot(): Promise<{ latestBlock: Block | null; finalizedCount: number; stateRoot: Uint8Array }> {
    const stateRoot = await this.store.root()
    return {
      latestBlock: this.node.latestBlock,
      finalizedCount: this.#finalizedBlocks.length,
      stateRoot,
    }
  }
}
