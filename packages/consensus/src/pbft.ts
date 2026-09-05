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

import type { Block, StateMachine, TransactionReceipt, SignatureVerifier } from '@johnhenry/raijin-core'
import { hash, merkleRoot, encodeReceipt, encodeBlockHeader, equal, toHex } from '@johnhenry/raijin-core'
import { ValidatorSet } from './validator-set.js'
import { voteDigest, NO_BLOCK_DIGEST, type VotePhase } from './vote.js'
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
  /**
   * Verify a signature against a message and the claimed signer's public
   * key. Used to authenticate PRE-PREPARE, PREPARE, COMMIT, and VIEW-CHANGE
   * votes before they're acted on — without this, any peer that can reach
   * `#handleMessage` could forge votes on behalf of any validator.
   *
   * Every vote is signed over a domain-separated payload (see `voteDigest`)
   * that names the phase, the view and the sequence, so no signature is
   * reusable in another phase or another round.
   */
  verify: SignatureVerifier
}

export class PBFTConsensus {
  #identity: Uint8Array
  #identityHex: string
  #validators: ValidatorSet
  #transport: NetworkTransport
  #timer: ConsensusTimer
  #stateMachine: StateMachine
  #sign: (message: Uint8Array) => Promise<Uint8Array>
  #verify: SignatureVerifier
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
  #viewChanges = new Map<string, Map<string, ViewChangeMessage>>() // newView → (validator_hex → message), deduped by sender
  #pendingBlock: Block | null = null
  #pendingDigest: Uint8Array | null = null
  /**
   * Sequence → digest of the last block that reached a PREPARE quorum
   * ("prepared certificate") at that sequence, across all views. Not
   * cleared on view change — this is a partial mitigation for the lack of
   * full prepared-certificate carry-over in NEW-VIEW: it stops a new leader
   * from getting a *conflicting* block accepted at a sequence that was
   * already validly prepared, even though it can't yet automatically
   * re-propose the original block. See tracking issue for full carry-over.
   */
  #preparedCert = new Map<string, Uint8Array>()

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
    this.#verify = config.verify
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

    // Broadcast PRE-PREPARE, signed so that acceptance does not rest on the
    // transport's `from` alone.
    const msg: PrePrepareMessage = {
      type: 'pre-prepare',
      view: this.#view,
      sequence: this.#sequence,
      block,
      digest,
      from: this.#identity,
      signature: await this.#signVote('pre-prepare', this.#view, this.#sequence, digest),
    }
    this.#transport.broadcast(msg)

    // Leader also sends PREPARE so other peers can count it
    const prepareSignature = await this.#signVote('prepare', this.#view, this.#sequence, digest)
    const prepare: PrepareMessage = {
      type: 'prepare',
      view: this.#view,
      sequence: this.#sequence,
      digest,
      from: this.#identity,
      signature: prepareSignature,
    }
    this.#transport.broadcast(prepare)
    await this.#addPrepare(digest, this.#identity)

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

    // Verify the leader actually signed this proposal. `from` comes from the
    // transport; the signature is what makes it mean something.
    if (!(await this.#verifyVote('pre-prepare', msg.view, msg.sequence, digest, msg.signature, from))) return

    // Partial view-change safety mitigation: if this sequence was already
    // validly prepared (2f+1 PREPARE votes) at some prior view, refuse to
    // accept a *different* block for the same sequence. We can't yet
    // automatically carry the old block forward, but we must not let a new
    // leader silently override an already-prepared one. See #doViewChange.
    const cert = this.#preparedCert.get(msg.sequence.toString())
    if (cert && !equal(cert, digest)) return

    // Accept the proposal
    this.#pendingBlock = msg.block
    this.#pendingDigest = digest
    this.#sequence = msg.sequence
    this.#phase = PBFTPhase.PrePrepared

    // Send PREPARE
    const signature = await this.#signVote('prepare', this.#view, this.#sequence, digest)
    const prepare: PrepareMessage = {
      type: 'prepare',
      view: this.#view,
      sequence: this.#sequence,
      digest,
      from: this.#identity,
      signature,
    }
    this.#transport.broadcast(prepare)
    await this.#addPrepare(digest, this.#identity)

    this.#resetViewTimer()
  }

  async #handlePrepare(from: Uint8Array, msg: PrepareMessage): Promise<void> {
    if (msg.view !== this.#view) return
    if (msg.sequence !== this.#sequence) return

    if (!(await this.#verifyVote('prepare', msg.view, msg.sequence, msg.digest, msg.signature, from))) return

    await this.#addPrepare(msg.digest, from)
  }

  async #handleCommit(from: Uint8Array, msg: CommitMessage): Promise<void> {
    if (msg.view !== this.#view) return
    if (msg.sequence !== this.#sequence) return

    if (!(await this.#verifyVote('commit', msg.view, msg.sequence, msg.digest, msg.signature, from))) return

    await this.#addCommit(msg.digest, from)
  }

  async #handleViewChange(from: Uint8Array, msg: ViewChangeMessage): Promise<void> {
    // A view change only ever moves forward. A VIEW-CHANGE signature covers
    // (newView, sequence) and nothing time-bound, so a recorded quorum stays
    // valid forever; without this check, replaying one rewinds `#view` and
    // clears every in-flight round, indefinitely, with no keys required.
    if (msg.newView <= this.#view) return

    if (!(await this.#verifyVote('view-change', msg.newView, msg.sequence, NO_BLOCK_DIGEST, msg.signature, from))) return

    const key = msg.newView.toString()
    if (!this.#viewChanges.has(key)) {
      this.#viewChanges.set(key, new Map())
    }
    // Dedup by sender: a single validator (Byzantine or just re-broadcasting)
    // must not be able to count more than once toward the quorum.
    this.#viewChanges.get(key)!.set(toHex(from), msg)

    const count = this.#viewChanges.get(key)!.size
    if (count >= this.#validators.quorumSize()) {
      this.#doViewChange(msg.newView)
    }
  }

  /**
   * Handle an incoming NEW-VIEW message. NEW-VIEW is not produced by this
   * implementation today (view changes complete directly once a quorum of
   * VIEW-CHANGE messages is observed — see #handleViewChange), but the
   * message type is part of the wire protocol and a malicious or buggy peer
   * could send one unsolicited. We must not act on it unless it's actually
   * backed by a real quorum (2f+1) of validly-signed, distinct-sender
   * VIEW-CHANGE messages agreeing on the claimed view — otherwise a single
   * validator could force every other node to jump views at will.
   */
  async #handleNewView(_from: Uint8Array, msg: NewViewMessage): Promise<void> {
    // Forward only — see #handleViewChange. A NEW-VIEW is the cheapest replay:
    // one message carrying a recorded quorum.
    if (msg.view <= this.#view) return

    const seenSenders = new Set<string>()

    for (const vc of msg.viewChanges) {
      if (vc.newView !== msg.view) continue
      if (!this.#validators.has(vc.from)) continue

      const hex = toHex(vc.from)
      if (seenSenders.has(hex)) continue // dedup by sender

      if (!(await this.#verifyVote('view-change', vc.newView, vc.sequence, NO_BLOCK_DIGEST, vc.signature, vc.from))) continue

      seenSenders.add(hex)
    }

    if (seenSenders.size < this.#validators.quorumSize()) return

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

    // Record the prepared certificate for this sequence (see #preparedCert
    // docs) — this survives view changes so a later view can't silently
    // override an already-prepared block with a conflicting one.
    this.#preparedCert.set(this.#sequence.toString(), digest)

    // Sign the digest and send COMMIT
    const signature = await this.#signVote('commit', this.#view, this.#sequence, digest)
    const commit: CommitMessage = {
      type: 'commit',
      view: this.#view,
      sequence: this.#sequence,
      digest,
      from: this.#identity,
      signature,
    }
    this.#transport.broadcast(commit)
    await this.#addCommit(digest, this.#identity)
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

    // The digest agreed upon during PRE-PREPARE/PREPARE/COMMIT was
    // necessarily computed *before* execution (state root/receipt root
    // can't be known ahead of running the block) — the header carried
    // zero-filled placeholders for those fields. Now that we've actually
    // executed the block, fill in the real values. This doesn't change the
    // already-agreed digest (nothing re-verifies it after this point); it
    // only affects the finalized block object used for chain linkage
    // (BlockProducer#advance hashes this completed header with `blockHash`
    // to get the next block's parentHash, so the link covers the executed
    // result as well as the proposal) and for fork/convergence detection in
    // the test harness.
    this.#pendingBlock.header.stateRoot = await this.#stateMachine.stateRoot()
    this.#pendingBlock.header.receiptRoot = await this.#computeReceiptRoot(receipts)

    const finalizedSequence = this.#sequence

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
    // This sequence is finalized — no future view change can conflict with
    // it, so the prepared-certificate guard is no longer needed for it.
    this.#preparedCert.delete(finalizedSequence.toString())

    // If we're the leader, schedule next block
    if (this.isLeader) {
      this.#startBlockTimer()
    }
    this.#resetViewTimer()
  }

  /** Merkle root over the block's transaction receipts. */
  async #computeReceiptRoot(receipts: TransactionReceipt[]): Promise<Uint8Array> {
    const leaves = await Promise.all(receipts.map((r) => hash(encodeReceipt(r))))
    return merkleRoot(leaves)
  }

  // ── View changes ────────────────────────────────────────────────────

  async #requestViewChange(): Promise<void> {
    const newView = this.#view + 1n
    const signature = await this.#signVote('view-change', newView, this.#sequence, NO_BLOCK_DIGEST)
    const msg: ViewChangeMessage = {
      type: 'view-change',
      newView,
      sequence: this.#sequence,
      from: this.#identity,
      signature,
    }
    this.#transport.broadcast(msg)

    // Also process our own view-change
    await this.#handleViewChange(this.#identity, msg)
  }

  /**
   * Apply a view change. NOTE: this does not carry forward the highest
   * prepared certificate from the old view (full PBFT view-change requires
   * the new leader to re-propose any block that reached a PREPARE quorum in
   * a prior view, at the same sequence). `#preparedCert` is a partial
   * mitigation — see its docs and `#handlePrePrepare` — that prevents a
   * *conflicting* re-proposal at an already-prepared sequence, but does not
   * by itself get the original block re-proposed. Full carry-over is
   * tracked as follow-up work.
   */
  #doViewChange(newView: bigint): void {
    if (newView <= this.#view) return
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

  /** Header bytes the consensus digest is taken over. Shared with
   *  `blockHash`, so the bytes nodes agree on and the bytes that link a block
   *  to its child are the same bytes. */
  #serializeBlockHeader(block: Block): Uint8Array {
    return encodeBlockHeader(block.header)
  }

  /** Sign one vote over its domain-separated payload (see `voteDigest`). */
  async #signVote(
    phase: VotePhase,
    view: bigint,
    sequence: bigint,
    digest: Uint8Array,
  ): Promise<Uint8Array> {
    return this.#sign(await voteDigest(phase, view, sequence, digest))
  }

  /** Verify one vote's signature against the claimed signer. */
  async #verifyVote(
    phase: VotePhase,
    view: bigint,
    sequence: bigint,
    digest: Uint8Array,
    signature: Uint8Array,
    signer: Uint8Array,
  ): Promise<boolean> {
    return this.#verify.verify(await voteDigest(phase, view, sequence, digest), signature, signer)
  }
}
