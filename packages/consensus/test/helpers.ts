/**
 * Test helpers: mock transport, timer, and multi-peer simulation.
 */

import type {
  NetworkTransport,
  ConsensusMessage,
  ConsensusTimer,
  TimerHandle,
  PrepareMessage,
  CommitMessage,
} from '../src/types.js'
import type { SignatureVerifier, Block } from '@johnhenry/raijin-core'
import { hash, encodeBlockHeader } from '@johnhenry/raijin-core'
import { voteDigest, NO_BLOCK_DIGEST, type VotePhase } from '../src/vote.js'
import { ValidatorSet } from '../src/validator-set.js'

/** In-memory transport that connects multiple peers. Tracks pending async work. */
export class MockNetwork {
  #peers = new Map<string, (from: Uint8Array, msg: ConsensusMessage) => void>()
  #pending: Promise<void>[] = []

  /** Wait for all in-flight message processing to complete. */
  async flush(): Promise<void> {
    while (this.#pending.length > 0) {
      const batch = this.#pending.splice(0)
      await Promise.allSettled(batch)
    }
  }

  /** Create a transport for a specific peer. */
  createTransport(peerId: Uint8Array): NetworkTransport {
    const peerHex = toHex(peerId)
    let handler: ((from: Uint8Array, msg: ConsensusMessage) => void) | null = null

    const transport: NetworkTransport = {
      broadcast: (msg: ConsensusMessage) => {
        for (const [id, h] of this.#peers) {
          if (id !== peerHex) {
            const cloned = JSON.parse(JSON.stringify(msg, bigIntReplacer), bigIntReviver)
            // Deliver synchronously — mirrors real WebRTC DataChannel behavior
            h(peerId, cloned)
          }
        }
      },
      send: (to: Uint8Array, msg: ConsensusMessage) => {
        const targetHex = toHex(to)
        const h = this.#peers.get(targetHex)
        if (h) {
          const cloned = JSON.parse(JSON.stringify(msg, bigIntReplacer), bigIntReviver)
          h(peerId, cloned)
        }
      },
      onMessage: (h: (from: Uint8Array, msg: ConsensusMessage) => void) => {
        handler = h
        this.#peers.set(peerHex, h)
      },
    }

    return transport
  }

  /** Disconnect a peer (simulates crash). */
  disconnect(peerId: Uint8Array): void {
    this.#peers.delete(toHex(peerId))
  }
}

/** Controllable timer for deterministic testing. */
export class MockTimer implements ConsensusTimer {
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

  /** Advance time by ms. Fires any timers that expire. */
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

  /** Number of pending timers. */
  get pending(): number {
    return this.#timers.size
  }
}

/**
 * Test signing/verification scheme: HMAC-SHA256 keyed by the signer's
 * "identity" bytes (used as the validator's public key throughout these
 * tests). This is NOT real asymmetric cryptography — deployments must use
 * a real signer/verifier (e.g. `Wallet`/`ed25519Verifier` from
 * @johnhenry/raijin-sdk / @johnhenry/raijin-core). It exists so that test
 * keys can be generated synchronously and deterministically
 * (`makeTestKey`), while still giving `mockVerifier` a *real* check: unlike
 * a trivial "always true" stub, it actually validates that the signature
 * corresponds to the claimed message and public key, so tests that forge a
 * signature (wrong signer, tampered digest, garbage bytes) are correctly
 * rejected.
 */
async function hmacKey(identity: Uint8Array): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    'raw',
    identity as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

/** Verifier for the HMAC-based test signing scheme (see `mockSign`). */
export const mockVerifier: SignatureVerifier = {
  async verify(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): Promise<boolean> {
    try {
      const key = await hmacKey(publicKey)
      return await globalThis.crypto.subtle.verify(
        'HMAC',
        key,
        signature as BufferSource,
        message as BufferSource,
      )
    } catch {
      return false
    }
  },
}

/** Signer for the HMAC-based test signing scheme (see `mockVerifier`). */
export function mockSign(identity: Uint8Array) {
  return async (message: Uint8Array): Promise<Uint8Array> => {
    const key = await hmacKey(identity)
    const signature = await globalThis.crypto.subtle.sign('HMAC', key, message as BufferSource)
    return new Uint8Array(signature)
  }
}

/** Generate a unique 32-byte test address. */
export function makeTestKey(id: number): Uint8Array {
  const key = new Uint8Array(32)
  key[0] = id
  return key
}

// ── JSON serialization helpers for bigint ──

function bigIntReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return { __bigint: value.toString() }
  if (value instanceof Uint8Array) return { __uint8array: Array.from(value) }
  return value
}

function bigIntReviver(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>
    if ('__bigint' in v) return BigInt(v.__bigint as string)
    if ('__uint8array' in v) return new Uint8Array(v.__uint8array as number[])
  }
  return value
}

function toHex(data: Uint8Array): string {
  return Array.from(data).map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Deterministic network that queues messages and delivers them one at a time,
 * awaiting each handler's async result before proceeding. This ensures the full
 * PBFT cascade (PRE-PREPARE → PREPARE → COMMIT) completes deterministically.
 */
export class DeterministicNetwork {
  #peers = new Map<string, (from: Uint8Array, msg: ConsensusMessage) => Promise<void> | void>()
  #queue: Array<{ from: Uint8Array; to: string; msg: ConsensusMessage }> = []

  /** Create a transport for a specific peer. */
  createTransport(peerId: Uint8Array): NetworkTransport {
    const peerHex = toHex(peerId)

    const transport: NetworkTransport = {
      broadcast: (msg: ConsensusMessage) => {
        for (const [id] of this.#peers) {
          if (id !== peerHex) {
            const cloned = JSON.parse(JSON.stringify(msg, bigIntReplacer), bigIntReviver)
            this.#queue.push({ from: peerId, to: id, msg: cloned })
          }
        }
      },
      send: (to: Uint8Array, msg: ConsensusMessage) => {
        const targetHex = toHex(to)
        const cloned = JSON.parse(JSON.stringify(msg, bigIntReplacer), bigIntReviver)
        this.#queue.push({ from: peerId, to: targetHex, msg: cloned })
      },
      onMessage: (h: (from: Uint8Array, msg: ConsensusMessage) => void) => {
        this.#peers.set(peerHex, h)
      },
    }

    return transport
  }

  /** Deliver ONE queued message and await the handler's return. */
  async deliver(): Promise<boolean> {
    const item = this.#queue.shift()
    if (!item) return false
    const handler = this.#peers.get(item.to)
    if (handler) {
      await handler(item.from, item.msg)
    }
    return true
  }

  /** Keep delivering until the queue is empty. */
  async drainAll(): Promise<number> {
    let count = 0
    while (this.#queue.length > 0) {
      await this.deliver()
      count++
    }
    return count
  }

  /** Number of messages currently queued. */
  get pending(): number {
    return this.#queue.length
  }

  /** Disconnect a peer (simulates crash). */
  disconnect(peerId: Uint8Array): void {
    this.#peers.delete(toHex(peerId))
  }
}

// ── Byzantine peers ───────────────────────────────────────────────────

/**
 * A validator that lies.
 *
 * Crash faults are the easy half of the fault model and the only half the
 * rest of this harness models: a crashed node *stops*. A Byzantine node
 * keeps sending — it just sends things a correct implementation never
 * would. It holds a real key, so every message it emits carries a
 * genuinely valid signature; authentication is not the thing that stops
 * it. What stops it is quorum intersection and the three-phase commit,
 * and that is what these peers exist to test.
 *
 * `ByzantinePeer` is deliberately *not* a `PBFTConsensus`. It has no
 * phase, no state machine and no notion of correctness — it is a raw
 * transport plus a signing key plus the ability to address individual
 * peers. Anything the wire format permits, it can say.
 *
 * The primitives below cover the attacks worth testing:
 *  - `prePrepare`/`prepare`/`commit`/`viewChange` — correctly-signed votes
 *    sent to a *chosen subset* of peers rather than broadcast, which is
 *    all equivocation actually is.
 *  - `equivocate` — the canonical Byzantine leader: two different blocks
 *    proposed at the same (view, sequence) to two disjoint groups.
 *  - `replayAs` — take a vote it overheard and re-emit it under a
 *    different phase, view or sequence, keeping the original signature.
 *  - `received` — everything it overheard, so a test can replay real
 *    traffic rather than hand-built messages.
 */
export class ByzantinePeer {
  readonly publicKey: Uint8Array
  /** Every message this peer overheard, in delivery order. */
  readonly received: Array<{ from: Uint8Array; msg: ConsensusMessage }> = []

  #transport: NetworkTransport
  #sign: (message: Uint8Array) => Promise<Uint8Array>
  #spoof: ((identity: Uint8Array) => NetworkTransport) | null
  #chainId: bigint
  #validators: ValidatorSet

  /**
   * @param chainId     The deployment this peer is voting in. Required for
   *                    the same reason `PBFTConsensus` requires it: a vote
   *                    that does not name its chain is replayable into every
   *                    other chain that shares a validator.
   * @param validators  The validator set this peer is voting under; its
   *                    `epoch()` goes into every signed payload. A liar that
   *                    signed under a different set would simply produce
   *                    invalid signatures, which tests nothing.
   * @param listen      Register a message handler so the peer receives
   *                    broadcasts. Required for replay attacks (it has to
   *                    hear a vote before it can re-emit one) and for the
   *                    peer to be a broadcast target at all.
   * @param spoof       A factory for a transport that reports an arbitrary
   *                    sender id — pass `(id) => network.createTransport(id)`.
   *
   *                    This models a transport that does not authenticate its
   *                    peers: a relay, a gossip hub, a signalling server
   *                    forwarding a self-declared id. `PBFTConsensus` is
   *                    written for exactly that world — it takes the `from`
   *                    the transport hands it as a *claim* and makes every
   *                    message carry a signature over `voteDigest(...)` to
   *                    settle it. Without a spoofing transport a test cannot
   *                    reach those checks at all, because the in-memory
   *                    networks here bind `from` to the transport that sent
   *                    the message and so authenticate every peer for free.
   */
  constructor(
    publicKey: Uint8Array,
    transport: NetworkTransport,
    opts: {
      chainId: bigint
      validators: ValidatorSet
      listen?: boolean
      spoof?: (identity: Uint8Array) => NetworkTransport
    },
  ) {
    this.publicKey = publicKey
    this.#transport = transport
    this.#sign = mockSign(publicKey)
    this.#spoof = opts.spoof ?? null
    this.#chainId = opts.chainId
    this.#validators = opts.validators
    if (opts.listen ?? true) {
      this.#transport.onMessage((from, msg) => {
        this.received.push({ from, msg })
      })
    }
  }

  /** The digest PBFT agrees on for a block: `H(encodeBlockHeader(header))`. */
  static async digestOf(block: Block): Promise<Uint8Array> {
    return hash(encodeBlockHeader(block.header))
  }

  /** Sign one vote exactly as an honest validator would. */
  async signVote(
    phase: VotePhase,
    view: bigint,
    sequence: bigint,
    digest: Uint8Array,
  ): Promise<Uint8Array> {
    return this.#sign(
      await voteDigest({
        phase,
        chainId: this.#chainId,
        epoch: await this.#validators.epoch(),
        view,
        sequence,
        digest,
      }),
    )
  }

  /** Send a fully-formed message to exactly one peer. */
  sendTo(to: Uint8Array, msg: ConsensusMessage): void {
    this.#transport.send(to, msg)
  }

  /** Send a fully-formed message to a chosen subset of peers. */
  sendToAll(targets: Uint8Array[], msg: ConsensusMessage): void {
    for (const to of targets) this.#transport.send(to, msg)
  }

  /** A validly-signed PRE-PREPARE for `block`, sent only to `targets`. */
  async prePrepare(
    targets: Uint8Array[],
    view: bigint,
    sequence: bigint,
    block: Block,
  ): Promise<Uint8Array> {
    const digest = await ByzantinePeer.digestOf(block)
    this.sendToAll(targets, {
      type: 'pre-prepare',
      view,
      sequence,
      block,
      digest,
      from: this.publicKey,
      signature: await this.signVote('pre-prepare', view, sequence, digest),
    })
    return digest
  }

  /** A validly-signed PREPARE, sent only to `targets`. */
  async prepare(
    targets: Uint8Array[],
    view: bigint,
    sequence: bigint,
    digest: Uint8Array,
  ): Promise<void> {
    this.sendToAll(targets, {
      type: 'prepare',
      view,
      sequence,
      digest,
      from: this.publicKey,
      signature: await this.signVote('prepare', view, sequence, digest),
    })
  }

  /** A validly-signed COMMIT, sent only to `targets`. */
  async commit(
    targets: Uint8Array[],
    view: bigint,
    sequence: bigint,
    digest: Uint8Array,
  ): Promise<void> {
    this.sendToAll(targets, {
      type: 'commit',
      view,
      sequence,
      digest,
      from: this.publicKey,
      signature: await this.signVote('commit', view, sequence, digest),
    })
  }

  /** A validly-signed VIEW-CHANGE, sent only to `targets`. */
  async viewChange(
    targets: Uint8Array[],
    newView: bigint,
    sequence: bigint,
  ): Promise<void> {
    this.sendToAll(targets, {
      type: 'view-change',
      newView,
      sequence,
      from: this.publicKey,
      signature: await this.signVote('view-change', newView, sequence, NO_BLOCK_DIGEST),
    })
  }

  /**
   * The canonical Byzantine leader: propose two *different* blocks at the
   * same view and sequence to two disjoint groups, and back each with the
   * leader's own PREPARE (and optionally COMMIT) so each group sees a
   * self-consistent round.
   *
   * Every message is correctly signed. Nothing here is malformed; the lie
   * is entirely in who is told what.
   */
  async equivocate(opts: {
    view: bigint
    sequence: bigint
    groups: Array<{ targets: Uint8Array[]; block: Block }>
    /** Also send the leader's COMMIT to each group. Default: true. */
    commit?: boolean
  }): Promise<Uint8Array[]> {
    const digests: Uint8Array[] = []
    for (const group of opts.groups) {
      const digest = await this.prePrepare(group.targets, opts.view, opts.sequence, group.block)
      await this.prepare(group.targets, opts.view, opts.sequence, digest)
      if (opts.commit ?? true) {
        await this.commit(group.targets, opts.view, opts.sequence, digest)
      }
      digests.push(digest)
    }
    return digests
  }

  /**
   * Re-emit a vote this peer overheard, keeping the ORIGINAL sender and
   * the ORIGINAL signature, but changing the phase (and optionally the view
   * or sequence).
   *
   * This is the attack the domain-separated `voteDigest` exists to stop: a
   * PREPARE is broadcast to everyone, so if PREPARE and COMMIT sign the
   * same bytes, holding someone's PREPARE means holding their COMMIT.
   */
  replayAs(
    targets: Uint8Array[],
    original: PrepareMessage | CommitMessage,
    as: { type: 'prepare' | 'commit'; view?: bigint; sequence?: bigint },
  ): void {
    const msg = {
      type: as.type,
      view: as.view ?? original.view,
      sequence: as.sequence ?? original.sequence,
      digest: original.digest,
      from: original.from,
      signature: original.signature,
    } as ConsensusMessage
    // Send it under the ORIGINAL signer's id if a spoofing transport was
    // supplied — a replay that announces itself as coming from the attacker
    // is not a replay, it is a signature the receiver will check against the
    // wrong key. See the `spoof` option.
    const via = this.#spoof ? this.#spoof(original.from) : this.#transport
    for (const to of targets) via.send(to, msg)
  }

  /** Every PREPARE this peer overheard. */
  overheardPrepares(): PrepareMessage[] {
    return this.received
      .map((r) => r.msg)
      .filter((m): m is PrepareMessage => m.type === 'prepare')
  }
}
