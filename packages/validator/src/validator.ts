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
  GenesisConfig,
  KVBackend,
} from '@johnhenry/raijin-core'
import {
  StateMachine,
  InMemoryStateStore,
  encodeTx,
  encodeTxSigned,
  hash,
  toHex,
  fromHex,
  equal,
  createGenesisBlock,
  applyGenesisState,
  blockHash,
  encodeMessage,
  decodeMessage,
} from '@johnhenry/raijin-core'
import {
  PBFTConsensus,
  ValidatorSet,
  type NetworkTransport,
  type ConsensusTimer,
  type ConsensusMessage,
  type ConsensusSyncState,
  type TimerHandle,
} from '@johnhenry/raijin-consensus'
import { Mempool } from '@johnhenry/raijin-mempool'
import { BlockProducer } from './block-producer.js'

export interface ValidatorNodeConfig {
  /**
   * Chain identifier — which deployment this node belongs to. Required, with
   * no default: it is signed into every consensus vote, and a default id is
   * one that every deployment which never chose one would share, letting
   * votes replay between them. See `PBFTConfig.chainId`.
   */
  chainId: bigint
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
  /**
   * View-change timeout in ms — how long this node waits for the leader to
   * propose before requesting a view change. Default: 10000 (PBFTConsensus's
   * own default). Configurable mainly so tests/demos that exercise view
   * changes don't have to wait out a real 10s timeout on a mock clock.
   */
  viewTimeout?: number
  /**
   * Initial validator public keys (including self). Ignored in favour of
   * `genesis.validators` when `genesis` is set (and must then agree with it,
   * or be omitted).
   */
  validators?: Uint8Array[]
  /**
   * First-class genesis: chain id, ordered validator set and initial state,
   * from which every node deterministically derives the same block 0 (see
   * `createGenesisBlock`). When set, the node seeds a fresh store with the
   * genesis accounts, and its first block must have block 0 as its parent.
   * `genesis.chainId` must equal `chainId`.
   *
   * Omitted: legacy behaviour (no block 0; first block's parent hash is all
   * zeros). Every node of one chain must use the same mode.
   */
  genesis?: GenesisConfig
  /**
   * The expected genesis hash (`genesisHash(config)`), obtained OUT OF BAND
   * (config file, release notes, a trusted operator). With `genesis`: the
   * node refuses to run unless its genesis hashes to this. Without
   * `genesis`: the node starts uninitialised and `fetchGenesis()` accepts a
   * peer's genesis only if it hashes to this. There is deliberately no
   * trustless bootstrap: a peer cannot vouch for the genesis it serves.
   */
  genesisHash?: Uint8Array
  /** Transaction gossip between validators. Default: enabled. */
  gossip?: GossipConfig
  /** Maximum transactions per block. Default: 100. */
  maxTxPerBlock?: number
  /** Maximum mempool size. Default: 4096. */
  maxMempoolSize?: number
  /**
   * Durable chain-tip record so a restarted validator resumes from its last
   * committed block instead of genesis (pair it with a durable `store` such
   * as `PersistentStateStore`). See `CheckpointStore`.
   */
  checkpoint?: CheckpointStore
}

/**
 * Where a validator persists its consensus-side resume point: the last
 * finalized block (plus the view it was finalized in). One opaque record,
 * overwritten on every finalized block.
 *
 * Use a storage location SEPARATE from the state store's (a different
 * IndexedDB database, file, ...) -- sharing a key space with state would put
 * the record inside the state root.
 *
 * Crash ordering: a block's transactions reach the state store before the
 * checkpoint is written, so after a crash the store may be one block AHEAD of
 * the checkpoint (never behind). On start, a checkpoint whose block's
 * `stateRoot` does not match the store is rejected loudly; recover with
 * `syncFrom`/`importSyncState` from a peer rather than guessing.
 */
export interface CheckpointStore {
  load(): Promise<Uint8Array | null>
  save(record: Uint8Array): Promise<void>
}

/** A `CheckpointStore` over any `KVBackend` (e.g. `IndexedDbKVBackend`), under one key. */
export function kvCheckpointStore(backend: KVBackend, key = 'checkpoint'): CheckpointStore {
  return {
    async load() {
      return (await backend.loadAll()).get(key) ?? null
    },
    async save(record) {
      await backend.write({ puts: [[key, record]], deletes: [] })
    },
  }
}

export interface GossipConfig {
  /** Default true. `false` restores the old local-only `submitTransaction`. */
  enabled?: boolean
  /**
   * Peers each gossip round is sent to (a random subset of the other
   * validators). Default: all of them (`transport.broadcast`).
   */
  fanout?: number
  /**
   * Maximum hops a transaction travels (the originator's send is hop 1; a
   * receiver re-gossips only while `hops < maxHops`). Default 2: the
   * originator, then each receiver relays once.
   */
  maxHops?: number
}

/**
 * A `StateStore` that also supports whole-store export/import (see
 * `InMemoryStateStore.exportData`/`importData`). Not every `StateStore`
 * backend can reasonably support this (an IndexedDB/OPFS-backed one might
 * transfer differently) — `ValidatorNode`'s sync API feature-detects for it
 * at runtime and fails clearly rather than silently skipping state.
 */
export interface SyncableStateStore extends StateStore {
  exportData(): Map<string, Uint8Array>
  importData(data: Map<string, Uint8Array>): void
}

function isSyncable(store: StateStore): store is SyncableStateStore {
  return typeof (store as Partial<SyncableStateStore>).exportData === 'function'
    && typeof (store as Partial<SyncableStateStore>).importData === 'function'
}

/**
 * Everything a rejoining or freshly-restarted `ValidatorNode` needs to catch
 * up on a currently-running peer: its application state (via
 * `exportData`/`importData` — see `SyncableStateStore`) and its consensus
 * view/round state (see `ConsensusSyncState`). See `exportSyncState`/
 * `importSyncState`/`syncFrom`.
 */
export interface ValidatorSyncState {
  /** Raw state-store key→value data (see `SyncableStateStore.exportData`). */
  storeData: Map<string, Uint8Array>
  /**
   * The most recently finalized block, if any. Lets the rejoining node's
   * `BlockProducer` resume numbering and parent-hash linkage from the right
   * place (see `BlockProducer.advance`) instead of from genesis.
   */
  latestBlock: Block | null
  /** Consensus view/round state (see `PBFTConsensus.exportSyncState`). */
  consensus: ConsensusSyncState
}

/** Cap on concurrent inbound-gossip verifications (backpressure). */
const MAX_INFLIGHT_GOSSIP = 64

function sameKeys(a: Uint8Array[], b: Uint8Array[]): boolean {
  return a.length === b.length && a.every((k, i) => equal(k, b[i]))
}

export class ValidatorNode {
  #store: StateStore
  #stateMachine: StateMachine
  #consensus: PBFTConsensus | null = null
  #mempool: Mempool
  #blockProducer: BlockProducer | null = null
  #validatorSet: ValidatorSet | null = null
  #blockTime: number
  #timer: ConsensusTimer
  #blockTimerHandle: unknown = null
  #running = false
  #latestBlock: Block | null = null
  #onBlockFinalizedHandlers: ((block: Block, receipts: TransactionReceipt[]) => void)[] = []

  // Wiring kept for deferred consensus construction (see `fetchGenesis`).
  #config: ValidatorNodeConfig
  #transport: NetworkTransport
  #consensusHandler: ((from: Uint8Array, msg: ConsensusMessage) => void) | null = null

  // Gossip
  #gossipEnabled: boolean
  #gossipFanout: number | undefined
  #gossipMaxHops: number
  #maxSeen: number
  #seen = new Set<string>()
  #inflightGossip = 0

  /** Last failed `checkpoint.save` (surfaced via `checkpointError`). */
  #checkpointError: unknown = null

  // Genesis
  #genesis: GenesisConfig | null = null
  #genesisBlock: Block | null = null
  #expectedGenesisHash: Uint8Array | null
  #genesisApplied = true
  #ready: Promise<void>
  #resolveReady: (() => void) | null = null
  #genesisWaiter: {
    resolve: (g: GenesisConfig) => void
    reject: (e: Error) => void
    timer: TimerHandle
  } | null = null

  constructor(config: ValidatorNodeConfig) {
    const {
      identity,
      transport,
      timer,
      store,
      blockTime = 2000,
      validators = [],
      maxMempoolSize = 4096,
      genesis,
      genesisHash: expectedGenesisHash,
      gossip = {},
    } = config

    this.#config = config
    this.#transport = transport
    this.#blockTime = blockTime
    this.#timer = timer
    this.#store = store
    this.#expectedGenesisHash = expectedGenesisHash ?? null

    this.#gossipEnabled = gossip.enabled ?? true
    this.#gossipFanout = gossip.fanout
    this.#gossipMaxHops = gossip.maxHops ?? 2
    this.#maxSeen = Math.max(1024, maxMempoolSize * 4)
    if (this.#gossipFanout !== undefined && !(this.#gossipFanout >= 1)) {
      throw new Error('ValidatorNode: gossip.fanout must be >= 1')
    }
    if (!(this.#gossipMaxHops >= 1)) {
      throw new Error('ValidatorNode: gossip.maxHops must be >= 1')
    }

    // Create state machine
    this.#stateMachine = new StateMachine(store, identity.verify)

    // Create mempool — the real, signature-verified, fee-ordered mempool
    // (@johnhenry/raijin-mempool), not a naive unvalidated queue. A
    // transaction's signature is verified against the same SignatureVerifier
    // used by the state machine, over the same unsigned encoding that's
    // actually signed.
    this.#mempool = new Mempool({
      maxSize: maxMempoolSize,
      verifier: async (tx) => identity.verify.verify(tx.from, tx.signature, encodeTx(tx)),
    })

    // One real transport handler, multiplexed: consensus votes go to PBFT,
    // transaction gossip and genesis exchange are handled here. `NetworkTransport`
    // keeps a single handler, so PBFT gets a view of the transport whose
    // `onMessage` registers with this dispatcher instead.
    transport.onMessage((from, msg) => this.#dispatch(from, msg))

    if (genesis) {
      if (genesis.chainId !== config.chainId) {
        throw new Error(
          `ValidatorNode: genesis.chainId (${genesis.chainId}) does not match chainId (${config.chainId})`,
        )
      }
      if (validators.length > 0 && !sameKeys(validators, genesis.validators)) {
        throw new Error('ValidatorNode: `validators` disagrees with `genesis.validators` — set only one, or make them identical')
      }
      this.#genesis = genesis
      this.#initConsensus(genesis.validators)
      this.#genesisApplied = false
      this.#ready = this.#prepareGenesis(genesis)
      this.#ready.catch(() => {}) // surfaced via ready()/create(); never an unhandled rejection
    } else if (this.#expectedGenesisHash && validators.length === 0) {
      // Uninitialised: waits for fetchGenesis().
      this.#ready = new Promise<void>((resolve) => { this.#resolveReady = resolve })
    } else if (this.#expectedGenesisHash) {
      throw new Error(
        'ValidatorNode: `genesisHash` needs `genesis` (to check it) or no `validators` (to fetchGenesis()); '
        + 'a bare validator list has no genesis to verify',
      )
    } else {
      this.#initConsensus(validators)
      if (config.checkpoint) {
        this.#genesisApplied = false
        this.#ready = this.#restoreCheckpoint()
        this.#ready.catch(() => {})
      } else {
        this.#ready = Promise.resolve()
      }
    }
  }

  /**
   * Construct a node and wait until its genesis is verified and applied.
   * Rejects if `genesis` does not hash to `genesisHash`. (For a node waiting
   * on `fetchGenesis()`, construct directly instead.)
   */
  static async create(config: ValidatorNodeConfig): Promise<ValidatorNode> {
    const node = new ValidatorNode(config)
    if (config.genesis || !config.genesisHash) await node.ready()
    return node
  }

  /**
   * Resolves once genesis (if configured) has been verified against
   * `genesisHash` and applied to the store; rejects if it does not match.
   * Resolves immediately for a node with no genesis. For a node awaiting
   * `fetchGenesis()`, resolves when that completes.
   */
  ready(): Promise<void> {
    return this.#ready
  }

  #initConsensus(validators: Uint8Array[]): void {
    const { chainId, identity, timer, viewTimeout, maxTxPerBlock = 100 } = this.#config
    this.#validatorSet = new ValidatorSet(validators)
    const consensusTransport: NetworkTransport = {
      broadcast: (m) => this.#transport.broadcast(m),
      send: (to, m) => this.#transport.send(to, m),
      onMessage: (h) => { this.#consensusHandler = h },
    }

    // Create consensus engine
    this.#consensus = new PBFTConsensus({
      identity: identity.publicKey,
      chainId,
      validators: this.#validatorSet,
      transport: consensusTransport,
      timer,
      stateMachine: this.#stateMachine,
      blockTime: this.#blockTime,
      viewTimeout,
      sign: identity.sign,
      verify: identity.verify,
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

  #need<T>(v: T | null): T {
    if (v === null) {
      throw new Error(
        'ValidatorNode is not initialised: it was given a `genesisHash` but no genesis — await fetchGenesis() first',
      )
    }
    return v
  }

  async #prepareGenesis(genesis: GenesisConfig): Promise<void> {
    const block = await createGenesisBlock(genesis)
    if (this.#expectedGenesisHash && !equal(await blockHash(block), this.#expectedGenesisHash)) {
      throw new Error(
        `ValidatorNode: genesis mismatch — this node's genesis hashes to ${toHex(await blockHash(block))}, `
        + `expected ${toHex(this.#expectedGenesisHash)}; refusing to run`,
      )
    }
    // Seed only a fresh store: a restarted node's store already holds
    // (later) state and must not be rewound.
    if (equal(await this.#store.root(), await new InMemoryStateStore().root())) {
      await applyGenesisState(this.#store, genesis)
    }
    this.#genesis = genesis
    this.#genesisBlock = block
    await this.#blockProducer!.advance(block)
    await this.#consensus!.seedFinalized(block)
    await this.#restoreCheckpoint()
    this.#genesisApplied = true
  }

  /**
   * Resume from the persisted chain tip, if a `checkpoint` store is
   * configured and holds one. Refuses a checkpoint that disagrees with the
   * state store (see `CheckpointStore`).
   */
  async #restoreCheckpoint(): Promise<void> {
    const cp = this.#config.checkpoint
    if (!cp) return
    const bytes = await cp.load()
    if (bytes) {
      const rec = decodeMessage<{ latestBlock: Block }>(bytes)
      const block = rec.latestBlock
      const storeRoot = await this.#store.root()
      if (!equal(storeRoot, block.header.stateRoot)) {
        throw new Error(
          `ValidatorNode: checkpoint (block ${block.header.number}) does not match the state store `
          + `(root ${toHex(storeRoot)}, checkpoint expects ${toHex(block.header.stateRoot)}); `
          + 'the store and checkpoint diverged (crash between writes, or mismatched storage) -- resync from a peer',
        )
      }
      this.#latestBlock = block
      await this.#need(this.#blockProducer).advance(block)
      await this.#need(this.#consensus).seedFinalized(block)
    }
    this.#genesisApplied = true
  }

  /** Genesis block (block 0), once genesis is configured and applied; else null. */
  get genesisBlock(): Block | null {
    return this.#genesisBlock
  }

  /** The genesis config this node runs under, or null (legacy / not yet fetched). */
  get genesis(): GenesisConfig | null {
    return this.#genesis
  }

  /**
   * Fetch the genesis config from peers for a node started without it.
   *
   * Trust model: the node must already know the expected genesis hash
   * (`genesisHash`, obtained out of band). Peers' responses are accepted
   * only if they hash to it — a peer cannot vouch for itself, so there is
   * no trustless bootstrap, and a hostile peer can at most delay (not
   * poison) the fetch. Rejects on timeout. Completes initialisation, after
   * which `start()` may be called.
   */
  async fetchGenesis(opts: { timeoutMs?: number } = {}): Promise<GenesisConfig> {
    if (this.#genesis) return this.#genesis
    const expected = this.#expectedGenesisHash
    if (!expected) {
      throw new Error('ValidatorNode.fetchGenesis: requires `genesisHash` in the config (the out-of-band trust anchor)')
    }
    if (this.#genesisWaiter) throw new Error('ValidatorNode.fetchGenesis: already in progress')
    const timeoutMs = opts.timeoutMs ?? 5000

    const genesis = await new Promise<GenesisConfig>((resolve, reject) => {
      const timer = this.#timer.set(timeoutMs, () => {
        this.#genesisWaiter = null
        reject(new Error(`ValidatorNode.fetchGenesis: no peer served a genesis matching the expected hash within ${timeoutMs}ms`))
      })
      this.#genesisWaiter = { resolve, reject, timer }
      this.#transport.broadcast({ type: 'genesis-request' })
    })

    if (genesis.chainId !== this.#config.chainId) {
      throw new Error(
        `ValidatorNode.fetchGenesis: genesis.chainId (${genesis.chainId}) does not match chainId (${this.#config.chainId})`,
      )
    }
    this.#genesis = genesis
    this.#genesisApplied = false
    this.#initConsensus(genesis.validators)
    this.#ready = this.#prepareGenesis(genesis)
    await this.#ready
    this.#resolveReady?.()
    this.#resolveReady = null
    return genesis
  }

  // Returns the handler's promise (when there is one): some transports (and the
  // test harness's network) await the handler to know a delivery has settled.
  #dispatch(from: Uint8Array, msg: ConsensusMessage): void | Promise<void> {
    switch (msg.type) {
      case 'tx-gossip':
        return this.#onTxGossip(from, msg.tx, msg.hops).catch(() => {})
      case 'genesis-request':
        if (this.#genesis) {
          this.#transport.send(from, { type: 'genesis-response', genesis: this.#genesis })
        }
        return
      case 'genesis-response':
        return this.#onGenesisResponse(msg.genesis).catch(() => {})
      default:
        return this.#consensusHandler?.(from, msg) as void | Promise<void>
    }
  }

  async #onGenesisResponse(candidate: GenesisConfig): Promise<void> {
    const waiter = this.#genesisWaiter
    const expected = this.#expectedGenesisHash
    if (!waiter || !expected) return
    let ok = false
    try {
      ok = equal(await blockHash(await createGenesisBlock(candidate)), expected)
    } catch {
      ok = false // malformed — ignore, keep waiting for an honest peer
    }
    if (!ok || this.#genesisWaiter !== waiter) return
    this.#genesisWaiter = null
    this.#timer.clear(waiter.timer)
    waiter.resolve(candidate)
  }

  // ── Transaction gossip ──────────────────────────────────────────────

  #markSeen(txHashHex: string): void {
    this.#seen.add(txHashHex)
    if (this.#seen.size > this.#maxSeen) {
      // FIFO eviction: Sets iterate in insertion order.
      this.#seen.delete(this.#seen.values().next().value as string)
    }
  }

  #gossipOut(tx: Transaction, hops: number, exclude?: Uint8Array): void {
    if (!this.#gossipEnabled || !this.#consensus) return
    const msg: ConsensusMessage = { type: 'tx-gossip', tx, hops }
    const self = this.#config.identity.publicKey
    const peers = this.#validatorSet!.all().filter(
      (k) => !equal(k, self) && !(exclude && equal(k, exclude)),
    )
    const fanout = this.#gossipFanout
    if (fanout === undefined || fanout >= peers.length) {
      if (!exclude) this.#transport.broadcast(msg)
      else for (const p of peers) this.#transport.send(p, msg)
      return
    }
    // Random subset of `fanout` peers (partial Fisher-Yates).
    for (let i = 0; i < fanout; i++) {
      const j = i + Math.floor(Math.random() * (peers.length - i))
      ;[peers[i], peers[j]] = [peers[j], peers[i]]
      this.#transport.send(peers[i], msg)
    }
  }

  async #onTxGossip(from: Uint8Array, tx: Transaction, hops: number): Promise<void> {
    if (!this.#gossipEnabled || !this.#running || !this.#validatorSet) return
    if (!this.#validatorSet.has(from)) return // only validators may relay
    if (!Number.isInteger(hops) || hops < 1) return

    let key: string
    try {
      key = toHex(await hash(encodeTxSigned(tx)))
    } catch {
      return // malformed
    }
    if (this.#seen.has(key)) return

    // Backpressure, cheapest checks first, none of them marking the tx seen
    // (so it can still arrive later when there is room): a full pool that
    // this tx cannot displace, or too many verifications already running.
    if (!this.#mempool.hasCapacityFor(tx)) return
    if (this.#inflightGossip >= MAX_INFLIGHT_GOSSIP) return

    this.#markSeen(key)
    this.#inflightGossip++
    try {
      // Already consumed on-chain (a late gossip after the block landed)?
      const account = await this.#stateMachine.getAccount(tx.from)
      if (tx.nonce < account.nonce) return
      const accepted = await this.#mempool.submit(tx)
      if (accepted && hops < this.#gossipMaxHops) this.#gossipOut(tx, hops + 1, from)
    } finally {
      this.#inflightGossip--
    }
  }

  /** Start the validator node. */
  start(): void {
    if (this.#running) return
    const consensus = this.#need(this.#consensus)
    this.#running = true
    const begin = () => {
      if (!this.#running) return
      consensus.start()
      this.#scheduleBlockProduction()
    }
    if (this.#genesisApplied) begin()
    else this.#ready.then(begin, () => { this.#running = false }) // genesis mismatch: never starts
  }

  /** Stop the validator node. */
  stop(): void {
    if (!this.#running) return
    this.#running = false
    this.#consensus?.stop()
    if (this.#blockTimerHandle) {
      this.#timer.clear(this.#blockTimerHandle)
      this.#blockTimerHandle = null
    }
  }

  /**
   * Submit a transaction to the mempool, and (unless `gossip.enabled` is
   * false) relay it to the other validators so whichever one leads can
   * include it. Returns the tx hash hex on acceptance; throws if the
   * mempool rejects it (invalid signature, duplicate sender+nonce, or pool
   * full with no lower-fee tx to evict).
   */
  async submitTransaction(tx: Transaction): Promise<string> {
    const accepted = await this.#mempool.submit(tx)
    if (!accepted) {
      throw new Error('Transaction rejected by mempool (invalid signature, duplicate, or pool full)')
    }
    const txHash = toHex(await hash(encodeTxSigned(tx)))
    this.#markSeen(txHash)
    this.#gossipOut(tx, 1)
    return txHash
  }

  /** Register a handler for block finalization events. */
  onBlockFinalized(handler: (block: Block, receipts: TransactionReceipt[]) => void): void {
    this.#onBlockFinalizedHandlers.push(handler)
  }

  /** The most recently finalized block, or null if none. */
  get latestBlock(): Block | null {
    return this.#latestBlock
  }

  /** The most recent `checkpoint.save` failure, if any (finalization continues regardless). */
  get checkpointError(): unknown {
    return this.#checkpointError
  }

  /** Whether the node is running. */
  get running(): boolean {
    return this.#running
  }

  /** The underlying consensus engine (for advanced use). */
  get consensus(): PBFTConsensus {
    return this.#need(this.#consensus)
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
    return this.#need(this.#blockProducer)
  }

  /** The underlying state store (for advanced use — e.g. checking whether
   *  it's a `SyncableStateStore`). */
  get store(): StateStore {
    return this.#store
  }

  /**
   * Snapshot everything a rejoining/restarted peer needs to catch up: this
   * node's application state (requires the store to be a
   * `SyncableStateStore` — throws otherwise), its last finalized block, and
   * its consensus view/round state. See `importSyncState`/`syncFrom`.
   *
   * Awaits `PBFTConsensus.whenIdle()` before reading the store: without
   * this, a peer that calls `exportSyncState` while THIS node is in the
   * middle of `applyBlock` — which mutates the store one transaction at a
   * time, not atomically (see `StateMachine.applyBlock`'s own docs) — could
   * receive a store snapshot that reflects only some of the pending block's
   * transactions, one that no block's digest actually commits to (raijin#47).
   */
  async exportSyncState(): Promise<ValidatorSyncState> {
    await this.#ready
    if (!isSyncable(this.#store)) {
      throw new Error(
        'ValidatorNode.exportSyncState: this store does not support exportData()/importData() '
        + '(see SyncableStateStore) — state sync is unavailable for this backend',
      )
    }
    await this.#need(this.#consensus).whenIdle()
    return {
      storeData: this.#store.exportData(),
      latestBlock: this.#latestBlock,
      consensus: this.#need(this.#consensus).exportSyncState(),
    }
  }

  /**
   * Adopt a peer's exported state (see `exportSyncState`) after this node
   * has fallen behind — e.g. it just restarted after a crash, or a
   * partition it was on the wrong side of just healed. Call `start()`
   * first (see `PBFTConsensus.importSyncState`).
   *
   * Order matters: application state is imported before the consensus
   * round is adopted, so that if the round includes a PRE-PREPARE whose
   * digest commits to a stateRoot/receiptRoot, this node's own state is
   * already positioned to compute the same values were it to finalize the
   * round itself.
   */
  async importSyncState(state: ValidatorSyncState): Promise<void> {
    await this.#ready
    if (!isSyncable(this.#store)) {
      throw new Error(
        'ValidatorNode.importSyncState: this store does not support exportData()/importData() '
        + '(see SyncableStateStore) — state sync is unavailable for this backend',
      )
    }
    this.#store.importData(state.storeData)
    // A durable store writes imported data in the background; make it durable
    // before adopting the rest of the state.
    await (this.#store as { flush?: () => Promise<void> }).flush?.()

    if (state.latestBlock) {
      this.#latestBlock = state.latestBlock
      // The synced state already reflects this block's transactions having
      // been applied — leaving them in the mempool would let this node
      // (once it's caught up enough to lead) try to re-include a
      // transaction whose nonce the synced state has already consumed,
      // wasting a mempool slot on something the state machine can only
      // revert (raijin#47). Mirrors what a live `#onFinalized` does for
      // every block this node finalizes itself.
      this.#mempool.removeBatch(state.latestBlock.transactions)
      await this.#need(this.#blockProducer).advance(state.latestBlock)
      // Seed the consensus engine's own chain-tip bookkeeping (see
      // `PBFTConsensus.seedFinalized`) BEFORE adopting any round below, so
      // its defense-in-depth number/parent-hash guard in `#onCommitted`
      // checks against this node's true last-finalized block instead of
      // its own pre-sync genesis default.
      await this.#need(this.#consensus).seedFinalized(state.latestBlock)
    }

    // The `removeBatch` above only prunes the transactions the LATEST
    // imported block actually names. But the imported store may reflect
    // many earlier blocks this node never saw individually, and any sender
    // with pending transactions here may have had further nonces consumed
    // by one of those earlier, unseen blocks (raijin#51 — up to 194 of 196
    // pending transactions survived an import in the issue's repro for
    // exactly this reason). Reconcile every pending sender against the
    // freshly-imported account state directly, by nonce, rather than trying
    // to reconstruct which specific past blocks included what — this catches
    // all of them in one pass, regardless of how far behind this node's
    // mempool was.
    const pendingSenders = new Set(this.#mempool.pending().map((tx) => toHex(tx.from)))
    for (const senderHex of pendingSenders) {
      const senderBytes = fromHex(senderHex)
      const account = await this.#stateMachine.getAccount(senderBytes)
      this.#mempool.pruneBelowNonce(senderBytes, account.nonce)
    }

    await this.#need(this.#consensus).importSyncState(state.consensus)
  }

  /**
   * Convenience: fetch `peer`'s sync state and adopt it in one call. In a
   * real (non-same-process) deployment, `peer.exportSyncState()` would
   * instead be requested from the peer over some out-of-band channel (the
   * `NetworkTransport` used for consensus messages is broadcast/send only,
   * not request/response) and its result handed to `importSyncState` — the
   * data shape is what a wire protocol would carry either way.
   */
  async syncFrom(peer: ValidatorNode): Promise<void> {
    await this.importSyncState(await peer.exportSyncState())
  }

  #scheduleBlockProduction(): void {
    if (!this.#running) return
    this.#blockTimerHandle = this.#timer.set(this.#blockTime, async () => {
      if (!this.#running) return
      try {
        await this.#need(this.#blockProducer).produceBlock()
      } catch {
        // Block production can fail if we're not the leader or no pending txs — that's OK
      }
      this.#scheduleBlockProduction()
    })
  }

  async #onFinalized(block: Block, receipts: TransactionReceipt[]): Promise<void> {
    this.#latestBlock = block

    // Persist the resume point before anything else observes the block.
    if (this.#config.checkpoint) {
      try {
        await this.#config.checkpoint.save(
          encodeMessage({ latestBlock: block, view: this.#consensus ? this.#consensus.exportSyncState().view : 0n }),
        )
      } catch (e) {
        this.#checkpointError = e
      }
    }

    // Remove included transactions from the mempool
    this.#mempool.removeBatch(block.transactions)

    // Advance block producer state
    await this.#need(this.#blockProducer).advance(block)

    // Notify external handlers
    for (const handler of this.#onBlockFinalizedHandlers) {
      handler(block, receipts)
    }
  }
}
