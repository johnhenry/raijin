/**
 * ValidatorNode — the composition root that wires core + consensus + mempool
 * into a runnable validator node.
 */

import type {
  Block,
  Transaction,
  TransactionReceipt,
  StateStore,
  SignatureVerifier,
} from 'raijin-core'
import { StateMachine } from 'raijin-core'
import {
  PBFTConsensus,
  ValidatorSet,
  type NetworkTransport,
  type ConsensusTimer,
} from 'raijin-consensus'
import { Mempool } from './mempool.js'
import { BlockProducer } from './block-producer.js'

export interface ValidatorNodeConfig {
  /** This node's identity. */
  identity: {
    publicKey: Uint8Array
    sign: (message: Uint8Array) => Promise<Uint8Array>
    verify: SignatureVerifier
  }
  /** Network transport for consensus messages. */
  transport: NetworkTransport
  /** Timer for consensus timeouts (injectable for testing). */
  timer: ConsensusTimer
  /** State store (e.g., InMemoryStateStore). */
  store: StateStore
  /** Block production interval in ms. Default: 2000. */
  blockTime?: number
  /** Initial validator public keys (including self). */
  validators?: Uint8Array[]
  /** Maximum transactions per block. Default: 100. */
  maxTxPerBlock?: number
  /** Maximum mempool size. Default: 4096. */
  maxMempoolSize?: number
}

export class ValidatorNode {
  #stateMachine: StateMachine
  #consensus: PBFTConsensus
  #mempool: Mempool
  #blockProducer: BlockProducer
  #validatorSet: ValidatorSet
  #blockTime: number
  #timer: ConsensusTimer
  #blockTimerHandle: unknown = null
  #running = false
  #latestBlock: Block | null = null
  #onBlockFinalizedHandlers: ((block: Block, receipts: TransactionReceipt[]) => void)[] = []

  constructor(config: ValidatorNodeConfig) {
    const {
      identity,
      transport,
      timer,
      store,
      blockTime = 2000,
      validators = [],
      maxTxPerBlock = 100,
      maxMempoolSize = 4096,
    } = config

    this.#blockTime = blockTime
    this.#timer = timer

    // Create state machine
    this.#stateMachine = new StateMachine(store, identity.verify)

    // Create validator set
    this.#validatorSet = new ValidatorSet(validators)

    // Create mempool
    this.#mempool = new Mempool(maxMempoolSize)

    // Create consensus engine
    this.#consensus = new PBFTConsensus({
      identity: identity.publicKey,
      validators: this.#validatorSet,
      transport,
      timer,
      stateMachine: this.#stateMachine,
      blockTime,
      sign: identity.sign,
    })

    // Create block producer
    this.#blockProducer = new BlockProducer({
      proposer: identity.publicKey,
      consensus: this.#consensus,
      mempool: this.#mempool,
      maxTxPerBlock,
    })

    // Wire: when a block is finalized, remove included txs from mempool
    this.#consensus.onBlockFinalized((block, receipts) => {
      this.#onFinalized(block, receipts)
    })
  }

  /** Start the validator node. */
  start(): void {
    if (this.#running) return
    this.#running = true
    this.#consensus.start()
    this.#scheduleBlockProduction()
  }

  /** Stop the validator node. */
  stop(): void {
    if (!this.#running) return
    this.#running = false
    this.#consensus.stop()
    if (this.#blockTimerHandle) {
      this.#timer.clear(this.#blockTimerHandle)
      this.#blockTimerHandle = null
    }
  }

  /** Submit a transaction to the mempool. Returns the tx hash hex. */
  async submitTransaction(tx: Transaction): Promise<string> {
    return this.#mempool.add(tx)
  }

  /** Register a handler for block finalization events. */
  onBlockFinalized(handler: (block: Block, receipts: TransactionReceipt[]) => void): void {
    this.#onBlockFinalizedHandlers.push(handler)
  }

  /** The most recently finalized block, or null if none. */
  get latestBlock(): Block | null {
    return this.#latestBlock
  }

  /** Whether the node is running. */
  get running(): boolean {
    return this.#running
  }

  /** The underlying consensus engine (for advanced use). */
  get consensus(): PBFTConsensus {
    return this.#consensus
  }

  /** The underlying mempool (for advanced use). */
  get mempool(): Mempool {
    return this.#mempool
  }

  /** The underlying state machine (for advanced use). */
  get stateMachine(): StateMachine {
    return this.#stateMachine
  }

  /** The underlying block producer (for advanced use). */
  get blockProducer(): BlockProducer {
    return this.#blockProducer
  }

  #scheduleBlockProduction(): void {
    if (!this.#running) return
    this.#blockTimerHandle = this.#timer.set(this.#blockTime, async () => {
      if (!this.#running) return
      try {
        await this.#blockProducer.produceBlock()
      } catch {
        // Block production can fail if we're not the leader or no pending txs — that's OK
      }
      this.#scheduleBlockProduction()
    })
  }

  async #onFinalized(block: Block, receipts: TransactionReceipt[]): Promise<void> {
    this.#latestBlock = block

    // Remove included transactions from the mempool
    await this.#mempool.removeBatch(block.transactions)

    // Advance block producer state
    this.#blockProducer.advance(block)

    // Notify external handlers
    for (const handler of this.#onBlockFinalizedHandlers) {
      handler(block, receipts)
    }
  }
}
