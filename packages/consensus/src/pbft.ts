/**
 * PBFT consensus engine for Raijin.
 *
 * Implements a simplified Practical Byzantine Fault Tolerance protocol:
 * 1. Leader proposes a block (PRE-PREPARE)
 * 2. Validators acknowledge (PREPARE)
 * 3. Validators commit (COMMIT)
 * 4. Block is finalized when 2f+1 commits are collected
 *
 * View changes handle leader failure: if the leader doesn't propose
 * within the timeout, validators request a view change to rotate
 * to the next leader.
 */

import type { Block, StateMachine, TransactionReceipt } from 'raijin-core'
import { hash, encodeTx, equal, toHex } from 'raijin-core'
import { ValidatorSet } from './validator-set.js'
import type {
  NetworkTransport,
  ConsensusTimer,
  TimerHandle,
  ConsensusMessage,
  PrePrepareMessage,
  PrepareMessage,
  CommitMessage,
  ViewChangeMessage,
  NewViewMessage,
} from './types.js'
import { PBFTPhase } from './types.js'

export interface PBFTConfig {
  /** This node's public key. */
  identity: Uint8Array
  /** The validator set. */
  validators: ValidatorSet
  /** Network transport for sending/receiving messages. */
  transport: NetworkTransport
  /** Timer for timeouts (injectable for testing). */
  timer: ConsensusTimer
  /** The state machine to apply blocks to. */
  stateMachine: StateMachine
  /** Block production interval in ms. Default: 2000. */
  blockTime?: number
  /** View change timeout in ms. Default: 10000. */
  viewTimeout?: number
  /** Sign a message. */
  sign: (message: Uint8Array) => Promise<Uint8Array>
}

export class PBFTConsensus {
  #identity: Uint8Array
  #identityHex: string
  #validators: ValidatorSet
  #transport: NetworkTransport
  #timer: ConsensusTimer
  #stateMachine: StateMachine
  #sign: (message: Uint8Array) => Promise<Uint8Array>
  #blockTime: number
  #viewTimeout: number

  // ── State ──
  #view = 0n
  #sequence = 0n
  #phase = PBFTPhase.Idle
  #running = false

  // ── Message collection ──
  #prepares = new Map<string, Set<string>>() // digest_hex → set of validator_hex
  #commits = new Map<string, Set<string>>()  // digest_hex → set of validator_hex
  #viewChanges = new Map<string, ViewChangeMessage[]>() // newView → messages
  #pendingBlock: Block | null = null
  #pendingDigest: Uint8Array | null = null

  // ── Timers ──
  #blockTimer: TimerHandle | null = null
  #viewTimer: TimerHandle | null = null

  // ── Callbacks ──
  #onBlockFinalized: ((block: Block, receipts: TransactionReceipt[]) => void)[] = []
  #onViewChange: ((newView: bigint) => void)[] = []

  constructor(config: PBFTConfig) {
    this.#identity = config.identity
    this.#identityHex = toHex(config.identity)
    this.#validators = config.validators
    this.#transport = config.transport
    this.#timer = config.timer
    this.#stateMachine = config.stateMachine
    this.#sign = config.sign
    this.#blockTime = config.blockTime ?? 2000
    this.#viewTimeout = config.viewTimeout ?? 10000

    // Wire incoming messages
    this.#transport.onMessage((from, msg) => this.#handleMessage(from, msg))
  }

  // ── Public API ──────────────────────────────────────────────────────

  /** Start the consensus engine. */
  start(): void {
    if (this.#running) return
    this.#running = true
    this.#startViewTimer()

    // If we're the leader for the current view, start block timer
    if (this.isLeader) {
      this.#startBlockTimer()
    }
  }

  /** Stop the consensus engine. */
  stop(): void {
    this.#running = false
    if (this.#blockTimer) this.#timer.clear(this.#blockTimer)
    if (this.#viewTimer) this.#timer.clear(this.#viewTimer)
    this.#blockTimer = null
    this.#viewTimer = null
  }

  /** Propose a block (called by the leader). */
  async propose(block: Block): Promise<void> {
    if (!this.isLeader) throw new Error('Only the leader can propose')
    if (this.#phase !== PBFTPhase.Idle) throw new Error('Already in consensus round')

    const blockBytes = this.#serializeBlockHeader(block)
    const digest = await hash(blockBytes)

    this.#pendingBlock = block
    this.#pendingDigest = digest
    this.#sequence++
    this.#phase = PBFTPhase.PrePrepared

    // Broadcast PRE-PREPARE
    const msg: PrePrepareMessage = {
      type: 'pre-prepare',
      view: this.#view,
      sequence: this.#sequence,
      block,
      digest,
    }
    this.#transport.broadcast(msg)

    // Leader also sends PREPARE so other peers can count it
    const prepare: PrepareMessage = {
      type: 'prepare',
      view: this.#view,
      sequence: this.#sequence,
      digest,
      from: this.#identity,
    }
    this.#transport.broadcast(prepare)
    this.#addPrepare(digest, this.#identity)

    // Reset view timer (we're making progress)
    this.#resetViewTimer()
  }

  /** Register a callback for when a block is finalized. */
  onBlockFinalized(handler: (block: Block, receipts: TransactionReceipt[]) => void): void {
    this.#onBlockFinalized.push(handler)
  }

  /** Register a callback for view changes. */
  onViewChange(handler: (newView: bigint) => void): void {
    this.#onViewChange.push(handler)
  }

  /** Current view number. */
  get currentView(): bigint { return this.#view }

  /** Current sequence number. */
  get currentSequence(): bigint { return this.#sequence }

  /** Current consensus phase. */
  get phase(): PBFTPhase { return this.#phase }

  /** Whether this node is the current leader. */
  get isLeader(): boolean {
    const leader = this.#validators.leaderForView(this.#view)
    return equal(leader, this.#identity)
  }

  /** The current leader's public key. */
  get currentLeader(): Uint8Array {
    return this.#validators.leaderForView(this.#view)
  }

  /** Whether the engine is running. */
  get running(): boolean { return this.#running }

  // ── Message handlers ────────────────────────────────────────────────

  async #handleMessage(from: Uint8Array, msg: ConsensusMessage): Promise<void> {
    if (!this.#running) return
    if (!this.#validators.has(from)) return // Ignore non-validators

    switch (msg.type) {
      case 'pre-prepare': return this.#handlePrePrepare(from, msg)
      case 'prepare': return this.#handlePrepare(from, msg)
      case 'commit': return this.#handleCommit(from, msg)
      case 'view-change': return this.#handleViewChange(from, msg)
      case 'new-view': return this.#handleNewView(from, msg)
    }
  }

  async #handlePrePrepare(from: Uint8Array, msg: PrePrepareMessage): Promise<void> {
    // Only accept from the current leader
    const leader = this.#validators.leaderForView(msg.view)
    if (!equal(from, leader)) return

    // View must match
    if (msg.view !== this.#view) return

    // Verify digest
    const blockBytes = this.#serializeBlockHeader(msg.block)
    const digest = await hash(blockBytes)
    if (!equal(digest, msg.digest)) return

    // Accept the proposal
    this.#pendingBlock = msg.block
    this.#pendingDigest = digest
    this.#sequence = msg.sequence
    this.#phase = PBFTPhase.PrePrepared

    // Send PREPARE
    const prepare: PrepareMessage = {
      type: 'prepare',
      view: this.#view,
      sequence: this.#sequence,
      digest,
      from: this.#identity,
    }
    this.#transport.broadcast(prepare)
    this.#addPrepare(digest, this.#identity)

    this.#resetViewTimer()
  }

  async #handlePrepare(from: Uint8Array, msg: PrepareMessage): Promise<void> {
    if (msg.view !== this.#view) return
    if (msg.sequence !== this.#sequence) return

    await this.#addPrepare(msg.digest, from)
  }

  async #handleCommit(from: Uint8Array, msg: CommitMessage): Promise<void> {
    if (msg.view !== this.#view) return
    if (msg.sequence !== this.#sequence) return

    await this.#addCommit(msg.digest, from)
  }

  async #handleViewChange(from: Uint8Array, msg: ViewChangeMessage): Promise<void> {
    const key = msg.newView.toString()
    if (!this.#viewChanges.has(key)) {
      this.#viewChanges.set(key, [])
    }
    this.#viewChanges.get(key)!.push(msg)

    // Check if we have enough view-change messages
    const count = this.#viewChanges.get(key)!.length
    if (count >= this.#validators.quorumSize()) {
      this.#doViewChange(msg.newView)
    }
  }

  async #handleNewView(_from: Uint8Array, msg: NewViewMessage): Promise<void> {
    this.#doViewChange(msg.view)
  }

  // ── Prepare/Commit collection ───────────────────────────────────────

  async #addPrepare(digest: Uint8Array, from: Uint8Array): Promise<void> {
    const key = toHex(digest)
    if (!this.#prepares.has(key)) {
      this.#prepares.set(key, new Set())
    }
    this.#prepares.get(key)!.add(toHex(from))

    // Check quorum
    if (this.#prepares.get(key)!.size >= this.#validators.quorumSize()) {
      await this.#onPrepared(digest)
    }
  }

  async #onPrepared(digest: Uint8Array): Promise<void> {
    if (this.#phase !== PBFTPhase.PrePrepared) return
    this.#phase = PBFTPhase.Prepared

    // Sign the digest and send COMMIT
    const signature = await this.#sign(digest)
    const commit: CommitMessage = {
      type: 'commit',
      view: this.#view,
      sequence: this.#sequence,
      digest,
      from: this.#identity,
      signature,
    }
    this.#transport.broadcast(commit)
    this.#addCommit(digest, this.#identity)
  }

  async #addCommit(digest: Uint8Array, from: Uint8Array): Promise<void> {
    const key = toHex(digest)
    if (!this.#commits.has(key)) {
      this.#commits.set(key, new Set())
    }
    this.#commits.get(key)!.add(toHex(from))

    // Check quorum
    if (this.#commits.get(key)!.size >= this.#validators.quorumSize()) {
      await this.#onCommitted(digest)
    }
  }

  async #onCommitted(digest: Uint8Array): Promise<void> {
    if (this.#phase !== PBFTPhase.Prepared) return
    if (!this.#pendingBlock) return
    this.#phase = PBFTPhase.Committed

    // Apply block to state machine
    const receipts = await this.#stateMachine.applyBlock(this.#pendingBlock)

    // Notify listeners
    for (const handler of this.#onBlockFinalized) {
      handler(this.#pendingBlock, receipts)
    }

    // Reset for next round
    this.#phase = PBFTPhase.Idle
    this.#pendingBlock = null
    this.#pendingDigest = null
    this.#prepares.clear()
    this.#commits.clear()

    // If we're the leader, schedule next block
    if (this.isLeader) {
      this.#startBlockTimer()
    }
    this.#resetViewTimer()
  }

  // ── View changes ────────────────────────────────────────────────────

  #requestViewChange(): void {
    const newView = this.#view + 1n
    const msg: ViewChangeMessage = {
      type: 'view-change',
      newView,
      sequence: this.#sequence,
      from: this.#identity,
    }
    this.#transport.broadcast(msg)

    // Also process our own view-change
    this.#handleViewChange(this.#identity, msg)
  }

  #doViewChange(newView: bigint): void {
    this.#view = newView
    this.#phase = PBFTPhase.Idle
    this.#pendingBlock = null
    this.#pendingDigest = null
    this.#prepares.clear()
    this.#commits.clear()
    this.#viewChanges.clear()

    for (const handler of this.#onViewChange) {
      handler(newView)
    }

    // If we're the new leader, start proposing
    if (this.isLeader) {
      this.#startBlockTimer()
    }
    this.#resetViewTimer()
  }

  // ── Timers ──────────────────────────────────────────────────────────

  #startBlockTimer(): void {
    if (this.#blockTimer) this.#timer.clear(this.#blockTimer)
    this.#blockTimer = this.#timer.set(this.#blockTime, () => {
      // Leader: time to propose (caller provides the block via propose())
      // In practice, the ValidatorNode polls the mempool and calls propose()
    })
  }

  #startViewTimer(): void {
    if (this.#viewTimer) this.#timer.clear(this.#viewTimer)
    this.#viewTimer = this.#timer.set(this.#viewTimeout, () => {
      // Timeout: leader hasn't proposed. Request view change.
      this.#requestViewChange()
    })
  }

  #resetViewTimer(): void {
    this.#startViewTimer()
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  #serializeBlockHeader(block: Block): Uint8Array {
    // Deterministic serialization of block header fields
    const parts: Uint8Array[] = [
      this.#bigintToBytes(block.header.number),
      block.header.parentHash,
      block.header.stateRoot,
      block.header.txRoot,
      block.header.receiptRoot,
      this.#bigintToBytes(BigInt(block.header.timestamp)),
      block.header.proposer,
    ]
    const totalLen = parts.reduce((sum, p) => sum + p.length, 0)
    const result = new Uint8Array(totalLen)
    let pos = 0
    for (const part of parts) {
      result.set(part, pos)
      pos += part.length
    }
    return result
  }

  #bigintToBytes(value: bigint): Uint8Array {
    const hex = value.toString(16).padStart(16, '0')
    const bytes = new Uint8Array(8)
    for (let i = 0; i < 8; i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    }
    return bytes
  }
}
