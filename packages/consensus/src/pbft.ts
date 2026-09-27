/**
 * PBFT consensus engine for Raijin.
 *
 * Implements a simplified Practical Byzantine Fault Tolerance protocol:
 * 1. Leader proposes a block (PRE-PREPARE)
 * 2. Validators acknowledge (PREPARE)
 * 3. Validators commit (COMMIT)
 * 4. Block is finalized when a quorum of `n - f` commits is collected
 *
 * View changes handle leader failure: if the leader doesn't propose
 * within the timeout, validators request a view change to rotate
 * to the next leader.
 */

import type { Block, StateMachine, TransactionReceipt, SignatureVerifier } from '@johnhenry/raijin-core'
import { hash, merkleRoot, encodeReceipt, encodeBlockHeader, equal, toHex, blockHash } from '@johnhenry/raijin-core'
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
  ConsensusSyncState,
} from './types.js'
import { PBFTPhase } from './types.js'

/**
 * How many sequences beyond the one we're currently on a PREPARE/COMMIT may
 * be buffered for (see `#handlePrepare`/`#handleCommit`'s buffering of
 * out-of-order messages, and `#replayBuffered`).
 *
 * This PBFT variant runs one round at a time — `propose()` throws
 * "Already in consensus round" if called before the previous one finalizes,
 * i.e. no pipelining — so a correct peer never legitimately votes more than
 * one sequence ahead of us. Bounding the lookahead at 1 keeps a Byzantine
 * validator from parking unboundedly many (view, sequence) buckets in
 * memory by signing votes for arbitrary far-future sequences; anything
 * further out is simply not buffered.
 */
const MAX_SEQUENCE_LOOKAHEAD = 1n

/**
 * Cap, in ms, for the exponential backoff between VIEW-CHANGE retries (see
 * `#armViewChangeRetry` / raijin#48). Unbounded backoff would eventually
 * make "the partition healed five minutes ago" indistinguishable from "this
 * node gave up"; capping it keeps the node retrying at a bounded worst-case
 * cadence for as long as it takes a NEW-VIEW to actually land.
 */
const MAX_VIEW_CHANGE_BACKOFF_MS = 60_000

export interface PBFTConfig {
  /** This node's public key. */
  identity: Uint8Array
  /**
   * Chain identifier — which deployment this node's votes are about.
   *
   * Required, with no default, for the same reason `chainId` is required on
   * a transaction: a default is an id that every deployment which never
   * chose one shares, and votes would then replay verbatim between them.
   * Every vote signature covers it (see `voteDigest`).
   */
  chainId: bigint
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
   * that names the chain, the validator-set epoch, the phase, the view and
   * the sequence, so no signature is reusable in another phase, another
   * round, another chain, or across a membership change.
   */
  verify: SignatureVerifier
}

export class PBFTConsensus {
  #identity: Uint8Array
  #identityHex: string
  #chainId: bigint
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
  // digest_hex → validator_hex → the actual signed message. Keeping the
  // message (not just a marker that its sender voted) is what lets
  // `exportSyncState` hand a rejoining peer real, independently-verifiable
  // votes instead of an assertion that a quorum happened.
  #prepares = new Map<string, Map<string, PrepareMessage>>()
  #commits = new Map<string, Map<string, CommitMessage>>()
  #viewChanges = new Map<string, Map<string, ViewChangeMessage>>() // newView → (validator_hex → message), deduped by sender
  /**
   * The VIEW-CHANGE quorum that justified the *current* view (empty for
   * view 0, which needs no justification). `#doViewChange` clears
   * `#viewChanges` once a view change completes — this is the durable copy
   * that `exportSyncState` hands to a rejoining/behind peer so it can verify
   * *why* this is the current view instead of taking our word for it (see
   * `importSyncState`).
   */
  #viewJustification: ViewChangeMessage[] = []
  #pendingBlock: Block | null = null
  #pendingDigest: Uint8Array | null = null
  /**
   * The accepted PRE-PREPARE for the round in flight (view, `#sequence`),
   * or null when idle between rounds. Unlike `#pendingBlock`/`#pendingDigest`
   * (which exist for local execution), this retains the actual *signed*
   * message so `exportSyncState` can hand it to a rejoining peer, which
   * verifies it exactly as if it had arrived over the wire (see
   * `importSyncState`).
   */
  #pendingPrePrepare: PrePrepareMessage | null = null
  /**
   * PREPARE/COMMIT messages that arrived for a sequence ahead of
   * `#sequence` — i.e. before this node had seen (or processed) the
   * PRE-PREPARE that makes them meaningful. A transport that doesn't
   * guarantee cross-link ordering (a real network, or an unordered
   * in-memory pub/sub) can deliver a PREPARE before the PRE-PREPARE it
   * depends on even though both were sent in the "right" order, and the
   * naive response — drop it — throws away one of the votes the node needs
   * to reach quorum, stalling the round into an unnecessary view change.
   * Buffered here, keyed by "view:sequence", and replayed by
   * `#replayBuffered` once the matching PRE-PREPARE lands. Bounded by
   * `MAX_SEQUENCE_LOOKAHEAD`; cleared on view change along with everything
   * else scoped to the old view.
   */
  #pendingPrepares = new Map<string, Map<string, PrepareMessage>>()
  #pendingCommits = new Map<string, Map<string, CommitMessage>>()
  /**
   * A PRE-PREPARE for `#sequence + 1` that arrived before this node finished
   * the round currently in flight for `#sequence` (see raijin#47).
   *
   * Before this buffer existed, `#handlePrePrepare` accepted a PRE-PREPARE
   * for the next sequence unconditionally as soon as it verified (leader,
   * view, digest, signature) — with no check that THIS round had actually
   * finished. A transport that doesn't guarantee cross-link ordering can
   * easily deliver the leader's next PRE-PREPARE (sent the moment the
   * leader itself finalizes) to a node that is still short a COMMIT or two
   * for the round in flight, because those specific commits are still stuck
   * on a slower link. Accepting it then would silently abandon the
   * in-flight round — including any PREPARE/COMMIT votes already collected
   * for it — and start executing the next block on top of state that never
   * saw the one it skipped, which is exactly the "silent divergence" #47
   * reports; `applyBlock`'s own number/parent-hash guard (`#onCommitted`) is
   * the second, independent line of defense against the same failure mode.
   *
   * Buffered here (mirroring `#pendingPrepares`/`#pendingCommits`), keyed by
   * "view:sequence", and replayed by `#onCommitted` once the round it was
   * waiting on actually finalizes. Bounded the same way PREPARE/COMMIT
   * lookahead is: only `#sequence + MAX_SEQUENCE_LOOKAHEAD` is ever
   * buffered, so a Byzantine leader can't park unboundedly many rounds'
   * worth of proposals in memory. At most one message per key — only the
   * real leader for a view can produce a validly-signed PRE-PREPARE for it,
   * so there is nothing to dedupe by sender the way prepares/commits are.
   */
  #pendingPrePrepares = new Map<string, PrePrepareMessage>()
  /**
   * Sequence → digest of the last block that reached a PREPARE quorum
   * ("prepared certificate") at that sequence, across all views. Not
   * cleared on view change. Serves two purposes: `#handlePrePrepare` uses
   * it to refuse a *conflicting* re-proposal at an already-prepared
   * sequence, and `#doViewChange` uses it (together with `#preparedBlock`)
   * to automatically carry the prepared block itself forward into the new
   * view when this node becomes the new leader.
   */
  #preparedCert = new Map<string, Uint8Array>()
  /**
   * Sequence → the actual `Block` behind `#preparedCert`'s digest for that
   * sequence. `#preparedCert` alone is enough to *reject* a conflicting
   * proposal, but re-proposing the original block needs its full content,
   * not just the digest that commits to it — so this is kept alongside it
   * with the same lifecycle (set in `#onPrepared`, deleted in
   * `#onCommitted`, never cleared by a view change).
   */
  #preparedBlock = new Map<string, Block>()
  /**
   * The number and canonical hash (see `blockHash`) of the last block this
   * node has actually applied to its state machine — this node's own view
   * of the chain tip, checked in `#onCommitted` immediately before
   * `applyBlock` (see raijin#47). Independent of `#sequence`, which tracks
   * the round currently or most recently in flight and is trusted nowhere
   * near execution: the point of this pair is to catch a block being
   * applied out of order or on the wrong parent even if `#sequence`
   * bookkeeping itself is (or becomes, through some other bug) wrong.
   * `0n` / all-zero for a node that hasn't finalized anything yet —
   * matches `BlockProducer`'s own genesis convention, so a first block
   * numbered `1` with an all-zero `parentHash` passes cleanly. Advanced by
   * `#onCommitted` after every block this node executes itself, and seeded
   * by `seedFinalized` for a node that instead adopted its state via
   * `ValidatorNode.importSyncState`.
   */
  #lastFinalizedNumber = 0n
  #lastFinalizedHash: Uint8Array = new Uint8Array(32)
  /**
   * The in-progress `applyBlock` call, if any (see `#onCommitted`). Exposed
   * via `whenIdle` so `ValidatorNode.exportSyncState` can wait for it before
   * snapshotting the state store — otherwise a peer that calls
   * `exportSyncState` while this node is mid-`applyBlock` (which mutates the
   * store one transaction at a time, not atomically — see
   * `StateMachine.applyBlock`'s own docs) could walk away with a
   * half-applied state that no block's digest actually commits to (raijin#47).
   */
  #applyingBlock: Promise<TransactionReceipt[]> | null = null

  // ── Timers ──
  #blockTimer: TimerHandle | null = null
  #viewTimer: TimerHandle | null = null
  /**
   * Backoff, in ms, for the NEXT view-change retry this node will send if
   * its own VIEW-CHANGE (from `#requestViewChange`) doesn't complete a view
   * change by itself — e.g. during a network partition, where nothing else
   * may ever nudge this node's view forward (see raijin#48). `null` means no
   * retry is pending: either the ordinary "wait for the leader" view timer
   * is what's currently armed, or this node isn't waiting on a view change
   * at all. Reset to `null` every time `#startViewTimer` runs, which is
   * every path that represents real progress (propose, an accepted
   * PRE-PREPARE, a finalized block, a completed view change) — so a fresh
   * stall always starts backing off from `#viewTimeout` again rather than
   * resuming wherever an earlier, unrelated stall left off.
   */
  #viewChangeBackoffMs: number | null = null

  // ── Callbacks ──
  #onBlockFinalized: ((block: Block, receipts: TransactionReceipt[]) => void)[] = []
  #onViewChange: ((newView: bigint) => void)[] = []

  constructor(config: PBFTConfig) {
    // Guard the JS callers the type system does not reach: an undefined
    // chainId would otherwise be signed as a chain id of its own, and every
    // node that forgot one would agree with every other node that forgot one.
    if (typeof config.chainId !== 'bigint') {
      throw new TypeError('PBFTConsensus: chainId is required and must be a bigint')
    }

    this.#identity = config.identity
    this.#identityHex = toHex(config.identity)
    this.#chainId = config.chainId
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
    this.#pendingPrePrepare = msg
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
    await this.#addPrepare(prepare)

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

  /**
   * Resolves once any `applyBlock` this node currently has in flight (see
   * `#onCommitted`) has settled. `exportSyncState`'s own docs call it "safe
   * to call at any time, including mid-round" — true for the view/round
   * bookkeeping it snapshots, but the underlying state STORE can still be
   * mid-mutation if a peer asks for a sync while this node is applying its
   * own pending block one transaction at a time (raijin#47).
   * `ValidatorNode.exportSyncState` awaits this before calling the store's
   * `exportData()`, so a sync never hands out a half-applied state.
   *
   * Never rejects, even if the in-flight `applyBlock` itself fails — a
   * caller waiting only to know "is the mutation over" doesn't need (and
   * shouldn't have to handle) an error that's already being surfaced to
   * whatever originally awaited `applyBlock` inside `#onCommitted`.
   */
  async whenIdle(): Promise<void> {
    if (this.#applyingBlock) {
      await this.#applyingBlock.catch(() => {})
    }
  }

  /**
   * Seed this node's notion of the chain tip (`#lastFinalizedNumber`/
   * `#lastFinalizedHash` — see their docs) from a block adopted out of
   * band, i.e. via `ValidatorNode.importSyncState`'s state-store import
   * rather than by this node executing the block itself through
   * `#onCommitted`.
   *
   * Without this, a freshly-synced node would start `#onCommitted`'s
   * defense-in-depth check from genesis even though its imported store
   * already reflects a much later height, and would then refuse the very
   * next — legitimately ordered — block as "not lastFinalized + 1" (see
   * raijin#47).
   *
   * Only ever moves the tip forward: an out-of-band call must not be able
   * to regress a node's own, already-more-current view of the chain,
   * e.g. if this is called with a stale snapshot after this node has
   * already finalized further on its own.
   */
  async seedFinalized(block: Block): Promise<void> {
    if (block.header.number <= this.#lastFinalizedNumber) return
    this.#lastFinalizedNumber = block.header.number
    this.#lastFinalizedHash = await blockHash(block)
  }

  /**
   * Snapshot enough of this node's view/round state for a rejoining or
   * behind peer to catch up (see `importSyncState` and the `ConsensusSyncState`
   * docs). Cheap and side-effect free — safe to call at any time, including
   * mid-round.
   */
  exportSyncState(): ConsensusSyncState {
    const digestKey = this.#pendingDigest ? toHex(this.#pendingDigest) : null
    return {
      view: this.#view,
      viewChangeJustification: [...this.#viewJustification],
      sequence: this.#sequence,
      prePrepare: this.#pendingPrePrepare,
      prepares: digestKey ? [...(this.#prepares.get(digestKey)?.values() ?? [])] : [],
      commits: digestKey ? [...(this.#commits.get(digestKey)?.values() ?? [])] : [],
    }
  }

  /**
   * Adopt a peer's view/round state (see `exportSyncState`) after this node
   * has fallen behind — e.g. it just restarted after a crash or a partition
   * healed. Call `start()` first: this method replays messages through the
   * same handlers a live peer's messages go through, and those handlers
   * require the engine to be running to register on time (view/block
   * timers, etc.).
   *
   * Everything here is re-verified, never trusted on the exporting peer's
   * say-so:
   *  - Adopting a *newer* view requires an actual quorum (`n - f`) of
   *    validly-signed, distinct-sender VIEW-CHANGE messages agreeing on
   *    that view (skipped only for view 0, which needs no justification) —
   *    exactly the check `#handleNewView` applies to an unsolicited
   *    NEW-VIEW, because that is what this is: a NEW-VIEW obtained out of
   *    band instead of over the wire.
   *  - The in-flight round (if any) is adopted by replaying its PRE-PREPARE
   *    and PREPARE/COMMIT votes through `#handlePrePrepare`/`#handlePrepare`/
   *    `#handleCommit` — the exact authenticated path a live message takes,
   *    signatures included. A vote that doesn't verify contributes nothing,
   *    same as it wouldn't from the wire.
   *
   * Does not touch application state — pair with the state store's own
   * `exportData`/`importData` (see `ValidatorNode.importSyncState`) so the
   * state root the node computes for the next block agrees with its peers.
   */
  async importSyncState(state: ConsensusSyncState): Promise<void> {
    if (state.view > this.#view) {
      if (state.view > 0n) {
        const verified = await this.#verifyViewChangeQuorum(state.view, state.viewChangeJustification)
        if (!verified) {
          throw new Error(
            `importSyncState: view-change justification for view ${state.view} does not meet quorum`,
          )
        }
        // Seed `#viewChanges` with the verified quorum so `#doViewChange`
        // captures it into `#viewJustification` exactly as it would for a
        // quorum won live through `#handleViewChange`.
        const map = new Map<string, ViewChangeMessage>()
        for (const vc of state.viewChangeJustification) {
          if (vc.newView === state.view) map.set(toHex(vc.from), vc)
        }
        this.#viewChanges.set(state.view.toString(), map)
      }
      await this.#doViewChange(state.view)
    }

    // Catch the sequence counter up even when there's no in-flight round to
    // replay (idle far behind). If a round IS replayed below,
    // `#handlePrePrepare` overwrites this with the same value anyway --
    // and, since raijin#47, `#handlePrePrepare`'s own acceptance check for
    // the idle case is keyed off `#lastFinalizedNumber` rather than
    // `#sequence` (see its docs) specifically so this pre-bump can stay
    // this simple without fighting that check.
    if (state.sequence > this.#sequence) {
      this.#sequence = state.sequence
    }

    if (state.prePrepare && state.prePrepare.view === this.#view) {
      await this.#handlePrePrepare(state.prePrepare.from, state.prePrepare)
      for (const msg of state.prepares) {
        await this.#handlePrepare(msg.from, msg)
      }
      for (const msg of state.commits) {
        await this.#handleCommit(msg.from, msg)
      }
    }
  }

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

    // Only gate on sequence while a round is genuinely IN FLIGHT for this
    // node (`#phase !== Idle`) — that is precisely the scenario raijin#47
    // describes: a PRE-PREPARE for the next sequence arriving before this
    // node finished the round it's currently on. Accepting it now would
    // abandon that round (and the votes already collected for it) and
    // start executing the next block on state that never saw the one it
    // skipped. Buffer it instead, the same way `#handlePrepare`/
    // `#handleCommit` buffer an early PREPARE/COMMIT, and replay it from
    // `#onCommitted` once the in-flight round actually finalizes.
    //
    // Deliberately NOT gated at all while idle. It's tempting to also
    // require `msg.sequence === #lastFinalizedNumber + 1` there, but
    // `#sequence` (what a same-sequence check would have to compare
    // against) is the last round this node ATTEMPTED, not the last one it
    // FINALIZED — a view change can abandon a round that reached Prepared
    // but never Committed (see `#doViewChange`), landing back on Idle at
    // the SAME `#sequence` it was already on. The new view is entitled to
    // re-propose exactly that sequence, and a leader whose own bookkeeping
    // legitimately moved past it after such an abandonment is not the bug
    // this check exists for. Block-level correctness for whatever finally
    // gets proposed is `#onCommitted`'s job (its number/parent-hash guard
    // checks the BLOCK's own header against `#lastFinalizedNumber`/
    // `#lastFinalizedHash`, independent of this counter) — that is the
    // actual, independent safety net; this check only prevents abandoning
    // a round already in progress.
    if (this.#phase !== PBFTPhase.Idle) {
      if (msg.sequence < this.#sequence) return // stale -- we're already past this
      if (msg.sequence > this.#sequence) {
        if (msg.sequence > this.#sequence + MAX_SEQUENCE_LOOKAHEAD) return // too far ahead, drop
        this.#pendingPrePrepares.set(this.#bufferKey(msg.view, msg.sequence), msg)
        return
      }
    }

    // Partial view-change safety mitigation: if this sequence was already
    // validly prepared (a quorum of PREPARE votes) at some prior view, refuse to
    // accept a *different* block for the same sequence. We can't yet
    // automatically carry the old block forward, but we must not let a new
    // leader silently override an already-prepared one. See #doViewChange.
    const cert = this.#preparedCert.get(msg.sequence.toString())
    if (cert && !equal(cert, digest)) return

    // Accept the proposal
    this.#pendingBlock = msg.block
    this.#pendingDigest = digest
    this.#pendingPrePrepare = msg
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
    await this.#addPrepare(prepare)

    // Now that we know (view, sequence), replay any PREPARE/COMMIT that
    // arrived for it before we did — see `#pendingPrepares`/`#pendingCommits`.
    await this.#replayBuffered(msg.view, msg.sequence)

    this.#resetViewTimer()
  }

  async #handlePrepare(from: Uint8Array, msg: PrepareMessage): Promise<void> {
    if (msg.view !== this.#view) return
    // A correct peer votes at most one sequence ahead of us under this
    // (unpipelined) protocol; anything further is not worth buffering.
    if (msg.sequence < this.#sequence || msg.sequence > this.#sequence + MAX_SEQUENCE_LOOKAHEAD) return

    if (!(await this.#verifyVote('prepare', msg.view, msg.sequence, msg.digest, msg.signature, from))) return

    if (msg.sequence === this.#sequence) {
      await this.#addPrepare(msg)
      return
    }

    // Ahead of us: we haven't seen this round's PRE-PREPARE yet (it may
    // simply not have arrived — see the class-level note on buffering).
    // Hold it; `#handlePrePrepare` replays it once the PRE-PREPARE for
    // (msg.view, msg.sequence) is accepted.
    this.#bufferVote(this.#pendingPrepares, msg.view, msg.sequence, from, msg)
  }

  async #handleCommit(from: Uint8Array, msg: CommitMessage): Promise<void> {
    if (msg.view !== this.#view) return
    if (msg.sequence < this.#sequence || msg.sequence > this.#sequence + MAX_SEQUENCE_LOOKAHEAD) return

    if (!(await this.#verifyVote('commit', msg.view, msg.sequence, msg.digest, msg.signature, from))) return

    if (msg.sequence === this.#sequence) {
      await this.#addCommit(msg)
      return
    }

    this.#bufferVote(this.#pendingCommits, msg.view, msg.sequence, from, msg)
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
      await this.#doViewChange(msg.newView)
    }
  }

  /**
   * Handle an incoming NEW-VIEW message. NEW-VIEW is not produced by this
   * implementation today (view changes complete directly once a quorum of
   * VIEW-CHANGE messages is observed — see #handleViewChange), but the
   * message type is part of the wire protocol and a malicious or buggy peer
   * could send one unsolicited. We must not act on it unless it's actually
   * backed by a real quorum (`n - f`) of validly-signed, distinct-sender
   * VIEW-CHANGE messages agreeing on the claimed view — otherwise a single
   * validator could force every other node to jump views at will.
   */
  async #handleNewView(_from: Uint8Array, msg: NewViewMessage): Promise<void> {
    // Forward only — see #handleViewChange. A NEW-VIEW is the cheapest replay:
    // one message carrying a recorded quorum.
    if (msg.view <= this.#view) return

    if (!(await this.#verifyViewChangeQuorum(msg.view, msg.viewChanges))) return

    await this.#doViewChange(msg.view)
  }

  /**
   * Whether `viewChanges` contains a real quorum (`n - f`) of validly-signed,
   * distinct-sender VIEW-CHANGE messages all naming `view`. Shared by
   * `#handleNewView` (an unsolicited NEW-VIEW arriving over the wire) and
   * `importSyncState` (a NEW-VIEW-shaped claim arriving out of band from a
   * sync peer) — both are "someone claims this view is justified", and
   * neither may be believed without doing this check.
   */
  async #verifyViewChangeQuorum(view: bigint, viewChanges: ViewChangeMessage[]): Promise<boolean> {
    const seenSenders = new Set<string>()

    for (const vc of viewChanges) {
      if (vc.newView !== view) continue
      if (!this.#validators.has(vc.from)) continue

      const hex = toHex(vc.from)
      if (seenSenders.has(hex)) continue // dedup by sender

      if (!(await this.#verifyVote('view-change', vc.newView, vc.sequence, NO_BLOCK_DIGEST, vc.signature, vc.from))) continue

      seenSenders.add(hex)
    }

    return seenSenders.size >= this.#validators.quorumSize()
  }

  // ── Prepare/Commit collection ───────────────────────────────────────

  async #addPrepare(msg: PrepareMessage): Promise<void> {
    const key = toHex(msg.digest)
    if (!this.#prepares.has(key)) {
      this.#prepares.set(key, new Map())
    }
    // Dedup by sender: keyed by validator hex, so a resend or a buffered
    // replay of the same vote never counts twice toward quorum.
    this.#prepares.get(key)!.set(toHex(msg.from), msg)

    // Check quorum
    if (this.#prepares.get(key)!.size >= this.#validators.quorumSize()) {
      await this.#onPrepared(msg.digest)
    }
  }

  async #onPrepared(digest: Uint8Array): Promise<void> {
    if (this.#phase !== PBFTPhase.PrePrepared) return
    this.#phase = PBFTPhase.Prepared

    // Record the prepared certificate — and the block it certifies — for
    // this sequence (see #preparedCert / #preparedBlock docs). Both survive
    // view changes: the digest so a later view can't silently override an
    // already-prepared block with a conflicting one, the block so that if
    // *this* node becomes the new leader it can automatically re-propose
    // the very block it already prepared rather than only being able to
    // reject conflicts.
    this.#preparedCert.set(this.#sequence.toString(), digest)
    if (this.#pendingBlock) {
      this.#preparedBlock.set(this.#sequence.toString(), this.#pendingBlock)
    }

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
    await this.#addCommit(commit)
  }

  async #addCommit(msg: CommitMessage): Promise<void> {
    const key = toHex(msg.digest)
    if (!this.#commits.has(key)) {
      this.#commits.set(key, new Map())
    }
    this.#commits.get(key)!.set(toHex(msg.from), msg)

    // Check quorum
    if (this.#commits.get(key)!.size >= this.#validators.quorumSize()) {
      await this.#onCommitted(msg.digest)
    }
  }

  async #onCommitted(digest: Uint8Array): Promise<void> {
    if (this.#phase !== PBFTPhase.Prepared) return
    if (!this.#pendingBlock) return
    this.#phase = PBFTPhase.Committed

    // Defense in depth, independent of the ordering fix above (raijin#47):
    // refuse to apply a block that isn't the immediate successor of the one
    // this node last finalized, or whose parent hash doesn't match its
    // current chain tip. The early-PRE-PREPARE buffering in
    // `#handlePrePrepare` is what's SUPPOSED to make this unreachable in
    // practice, but this check does not depend on that ordering logic
    // having been applied correctly, here or on any future code path that
    // reaches `#onCommitted` (e.g. a bug in view-change carry-forward, or a
    // consensus round adopted via `importSyncState`) — it re-derives the
    // same guarantee straight from the block itself.
    if (this.#pendingBlock.header.number !== this.#lastFinalizedNumber + 1n) {
      throw new Error(
        `PBFTConsensus#onCommitted: refusing to apply block ${this.#pendingBlock.header.number} `
        + `-- expected ${this.#lastFinalizedNumber + 1n} (last finalized: ${this.#lastFinalizedNumber})`,
      )
    }
    if (!equal(this.#pendingBlock.header.parentHash, this.#lastFinalizedHash)) {
      throw new Error(
        `PBFTConsensus#onCommitted: refusing to apply block ${this.#pendingBlock.header.number} `
        + `-- its parentHash does not match this node's current chain tip`,
      )
    }

    // Apply block to state machine. Tracked in `#applyingBlock` so
    // `whenIdle` (used by `ValidatorNode.exportSyncState`) can wait for this
    // to finish rather than snapshotting the store mid-mutation (raijin#47).
    this.#applyingBlock = this.#stateMachine.applyBlock(this.#pendingBlock)
    let receipts: TransactionReceipt[]
    try {
      receipts = await this.#applyingBlock
    } finally {
      this.#applyingBlock = null
    }

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

    // This node has now genuinely observed this exact block applied to its
    // own state, in order, on the right parent -- advance the chain tip the
    // guard above checks against. Computed from the now-COMPLETE header
    // (real stateRoot/receiptRoot filled in above), the same bytes
    // `BlockProducer.advance` hashes for the next block's `parentHash` —
    // using the placeholder-zeroed header here would compute a hash the
    // real chain never produces, and the very next block would then fail
    // this same parent-hash check.
    this.#lastFinalizedNumber = this.#pendingBlock.header.number
    this.#lastFinalizedHash = await blockHash(this.#pendingBlock)

    const finalizedSequence = this.#sequence

    // Notify listeners
    for (const handler of this.#onBlockFinalized) {
      handler(this.#pendingBlock, receipts)
    }

    // Reset for next round
    this.#phase = PBFTPhase.Idle
    this.#pendingBlock = null
    this.#pendingDigest = null
    this.#pendingPrePrepare = null
    this.#prepares.clear()
    this.#commits.clear()
    // This sequence is finalized — no future view change can conflict with
    // it, so the prepared-certificate guard (and the block it would have
    // carried forward) is no longer needed for it.
    this.#preparedCert.delete(finalizedSequence.toString())
    this.#preparedBlock.delete(finalizedSequence.toString())

    // A PRE-PREPARE for the round right after this one may have arrived
    // while we were still finishing this round and been buffered rather
    // than accepted (see `#handlePrePrepare` and `#pendingPrePrepares`'s
    // docs, raijin#47). Now that we're idle again, replay it through the
    // normal, fully-verifying `#handlePrePrepare` path -- nothing here is
    // trusted merely because it was buffered.
    const nextKey = this.#bufferKey(this.#view, finalizedSequence + 1n)
    const bufferedPrePrepare = this.#pendingPrePrepares.get(nextKey)
    if (bufferedPrePrepare) {
      this.#pendingPrePrepares.delete(nextKey)
      await this.#handlePrePrepare(bufferedPrePrepare.from, bufferedPrePrepare)
    }

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

    // If that alone didn't complete the view change -- no quorum yet, e.g.
    // this node is on the healthy side of a partition, or it's simply the
    // first of possibly several honest nodes to time out -- `#doViewChange`
    // never ran, and so never re-armed the view timer either (see
    // raijin#48). Without doing so here, this node would send exactly one
    // VIEW-CHANGE for the rest of its life and then wait forever, even long
    // after a partition heals or a slow peer catches up. Re-arm with
    // backoff, still targeting `newView`: if a view change completes by any
    // means in the meantime (this node reaching quorum later, or adopting
    // an unsolicited but properly quorum-backed NEW-VIEW, or catching up via
    // `importSyncState`), `this.#view` will already have reached or passed
    // `newView` by the time the retry fires, making it a no-op.
    if (this.#view < newView) {
      this.#armViewChangeRetry(newView)
    }
  }

  /**
   * Re-arm after a VIEW-CHANGE this node sent did not, by itself, complete a
   * view change (see `#requestViewChange`, raijin#48). Backs off
   * exponentially from `#viewTimeout` (capped at `MAX_VIEW_CHANGE_BACKOFF_MS`)
   * and keeps retrying -- re-sending a VIEW-CHANGE for the same
   * `targetView` -- until either this node observes `targetView` (or a
   * later view) actually installed, or it stops running.
   */
  #armViewChangeRetry(targetView: bigint): void {
    if (this.#viewTimer) this.#timer.clear(this.#viewTimer)
    this.#viewChangeBackoffMs = Math.min(
      (this.#viewChangeBackoffMs ?? this.#viewTimeout) * 2,
      MAX_VIEW_CHANGE_BACKOFF_MS,
    )
    this.#viewTimer = this.#timer.set(this.#viewChangeBackoffMs, () => {
      if (!this.#running) return
      if (this.#view >= targetView) return // already installed (or superseded) -- nothing to retry
      this.#requestViewChange()
    })
  }

  /**
   * Apply a view change, carrying forward the highest prepared certificate
   * from the old view: if this node becomes the new leader and already
   * holds a prepared certificate (`#preparedCert` + `#preparedBlock`) for
   * the current sequence, it automatically re-proposes that exact block
   * under the new view instead of waiting for a fresh `propose()` call —
   * which is what closes the gap `#preparedCert` alone could only guard
   * (reject a conflicting re-proposal) but not fix (get the original block
   * re-proposed so the round can still finalize). A new leader that never
   * itself prepared the block (e.g. it was on the far side of a partition)
   * has no certificate to carry and falls back to normal block production;
   * `#handlePrePrepare`'s `#preparedCert` check still protects that case
   * against a conflicting proposal from anyone.
   */
  async #doViewChange(newView: bigint): Promise<void> {
    if (newView <= this.#view) return

    // Capture the quorum that justifies `newView` before `#viewChanges` is
    // cleared below — this is the durable copy `exportSyncState` hands to a
    // rejoining/behind peer (see `#viewJustification`'s docs). Populated
    // either by a quorum won live through `#handleViewChange`, or (for
    // `importSyncState`) by the externally-supplied quorum it seeds into
    // `#viewChanges` after independently verifying it — both are real,
    // verified quorums by the time they reach here.
    const justifying = this.#viewChanges.get(newView.toString())
    this.#viewJustification = justifying ? [...justifying.values()] : []

    this.#view = newView
    this.#phase = PBFTPhase.Idle
    this.#pendingBlock = null
    this.#pendingDigest = null
    this.#pendingPrePrepare = null
    this.#prepares.clear()
    this.#commits.clear()
    this.#viewChanges.clear()
    // Buffered votes were all scoped to `msg.view === <old #view>` when
    // buffered (see `#handlePrepare`/`#handleCommit`), so none of them can
    // ever be replayed once the view has moved on. Same for a buffered
    // early PRE-PREPARE (see `#handlePrePrepare`, raijin#47) — it was only
    // ever accepted from the leader of the OLD view, and view-change carries
    // the prepared block forward through `#reProposeCarried` instead, not
    // through anything sitting in this buffer.
    this.#pendingPrepares.clear()
    this.#pendingCommits.clear()
    this.#pendingPrePrepares.clear()

    for (const handler of this.#onViewChange) {
      handler(newView)
    }

    if (this.isLeader) {
      const seqKey = this.#sequence.toString()
      const carriedDigest = this.#preparedCert.get(seqKey)
      const carriedBlock = this.#preparedBlock.get(seqKey)
      if (carriedDigest && carriedBlock) {
        await this.#reProposeCarried(carriedBlock, carriedDigest)
      } else {
        this.#startBlockTimer()
      }
    }
    this.#resetViewTimer()
  }

  /**
   * Re-propose, under the new (current) view, a block that already reached
   * a PREPARE quorum at the current sequence in a prior view. Mirrors
   * `propose()`'s PRE-PREPARE/PREPARE broadcast, except the sequence is not
   * incremented and the digest is not recomputed — every honest replica
   * that prepared this block already agrees on that exact digest, and
   * recomputing it could only reproduce it or paper over a bug, never
   * legitimately change it.
   */
  async #reProposeCarried(block: Block, digest: Uint8Array): Promise<void> {
    this.#pendingBlock = block
    this.#pendingDigest = digest
    this.#phase = PBFTPhase.PrePrepared

    const msg: PrePrepareMessage = {
      type: 'pre-prepare',
      view: this.#view,
      sequence: this.#sequence,
      block,
      digest,
      from: this.#identity,
      signature: await this.#signVote('pre-prepare', this.#view, this.#sequence, digest),
    }
    this.#pendingPrePrepare = msg
    this.#transport.broadcast(msg)

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
    await this.#addPrepare(prepare)
    // No buffered-message replay here: `#doViewChange` (the only caller)
    // clears `#pendingPrepares`/`#pendingCommits` for the old view before
    // this runs, and nothing can have been buffered for the new view yet.
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
    // Every call site of `#startViewTimer` (directly, or via
    // `#resetViewTimer`) represents genuine progress -- a propose, an
    // accepted PRE-PREPARE, a finalized block, a completed view change --
    // so any view-change retry backoff that was building up (see
    // `#armViewChangeRetry`, raijin#48) no longer applies; the next stall,
    // if any, starts fresh from `#viewTimeout`.
    this.#viewChangeBackoffMs = null
    this.#viewTimer = this.#timer.set(this.#viewTimeout, () => {
      // Timeout: leader hasn't proposed. Request view change.
      this.#requestViewChange()
    })
  }

  #resetViewTimer(): void {
    this.#startViewTimer()
  }

  // ── Out-of-order PREPARE/COMMIT buffering ──────────────────────────

  /** The key `#pendingPrepares`/`#pendingCommits` are bucketed by. */
  #bufferKey(view: bigint, sequence: bigint): string {
    return `${view.toString()}:${sequence.toString()}`
  }

  /** Buffer one authenticated, out-of-order PREPARE or COMMIT, deduped by
   *  sender (same rule as the live `#prepares`/`#commits` maps: a resend
   *  must not occupy two slots or count twice once replayed). */
  #bufferVote<M extends PrepareMessage | CommitMessage>(
    buffer: Map<string, Map<string, M>>,
    view: bigint,
    sequence: bigint,
    from: Uint8Array,
    msg: M,
  ): void {
    const key = this.#bufferKey(view, sequence)
    if (!buffer.has(key)) buffer.set(key, new Map())
    buffer.get(key)!.set(toHex(from), msg)
  }

  /**
   * Replay PREPARE/COMMIT messages that arrived for (view, sequence) before
   * this node had accepted the PRE-PREPARE that makes them meaningful (see
   * `#handlePrepare`/`#handleCommit`). Called from `#handlePrePrepare` right
   * after the PRE-PREPARE is accepted.
   *
   * Prepares are replayed before commits: a commit only means anything once
   * we've counted enough prepares to reach `Prepared` ourselves (see
   * `#onCommitted`'s phase guard), so replaying commits first would let an
   * already-complete commit quorum arrive while we're still `PrePrepared`
   * and be silently dropped by that guard, with nothing left to re-trigger
   * it once we do reach `Prepared`.
   */
  async #replayBuffered(view: bigint, sequence: bigint): Promise<void> {
    const key = this.#bufferKey(view, sequence)

    const prepares = this.#pendingPrepares.get(key)
    this.#pendingPrepares.delete(key)
    if (prepares) {
      for (const msg of prepares.values()) {
        await this.#addPrepare(msg)
      }
    }

    const commits = this.#pendingCommits.get(key)
    this.#pendingCommits.delete(key)
    if (commits) {
      for (const msg of commits.values()) {
        await this.#addCommit(msg)
      }
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  /** Header bytes the consensus digest is taken over. Shared with
   *  `blockHash`, so the bytes nodes agree on and the bytes that link a block
   *  to its child are the same bytes. */
  #serializeBlockHeader(block: Block): Uint8Array {
    return encodeBlockHeader(block.header)
  }

  /**
   * The bytes of one vote (see `voteDigest`).
   *
   * `chainId` and the validator-set `epoch` come from *this* node, never from
   * the message. That is what makes them scope rather than metadata: a peer
   * cannot tell us which chain or which set its vote should count under, it
   * can only produce a signature that either matches ours or does not.
   */
  async #voteBytes(
    phase: VotePhase,
    view: bigint,
    sequence: bigint,
    digest: Uint8Array,
  ): Promise<Uint8Array> {
    return voteDigest({
      phase,
      chainId: this.#chainId,
      epoch: await this.#validators.epoch(),
      view,
      sequence,
      digest,
    })
  }

  /** Sign one vote over its domain-separated payload (see `voteDigest`). */
  async #signVote(
    phase: VotePhase,
    view: bigint,
    sequence: bigint,
    digest: Uint8Array,
  ): Promise<Uint8Array> {
    return this.#sign(await this.#voteBytes(phase, view, sequence, digest))
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
    return this.#verify.verify(
      await this.#voteBytes(phase, view, sequence, digest),
      signature,
      signer,
    )
  }
}
