/**
 * ByzantineTestNode — a validator in the cluster that lies.
 *
 * Everything else this harness can do to a node makes it *stop*: crash it,
 * partition it, drop its messages, delay them. Those are crash faults, and
 * they are the half of the fault model that does not need Byzantine fault
 * tolerance to survive. A Byzantine node keeps sending. It is a member of the
 * validator set, it holds a real key, and every message it emits is correctly
 * formed and correctly signed — the lie is in *what* it says and *who it says
 * it to*, which is the only thing signatures cannot fix.
 *
 * This is deliberately not a `RaijinTestNode`: it has no ValidatorNode, no
 * mempool, no state machine and no block producer, because an honest
 * implementation cannot be talked into equivocating. It is a transport, a
 * key, and the ability to address peers one at a time.
 *
 * The protocol-level primitives live on `ByzantinePeer`
 * (packages/consensus/test/helpers.ts), shared with the consensus unit tests
 * so there is one definition of "how a liar speaks PBFT". This class is the
 * cluster-level wrapper: it knows its orchestrator id and which peers exist.
 */

import type { Block } from '@johnhenry/raijin-core'
import type { NetworkTransport } from '@johnhenry/raijin-consensus'
// NOTE: from the consensus SOURCE, not from '@johnhenry/raijin-consensus'.
// That specifier resolves to the package's built `dist`, which is only as
// fresh as the last build — and `ByzantinePeer` (consensus/test/helpers.ts)
// already builds its vote payloads against the source. Two ValidatorSet
// classes from two builds would silently disagree about `epoch()`, and a
// disagreement about the epoch is an invalid signature, not a failing
// assertion. One source, one epoch.
import { ValidatorSet } from '../../../consensus/src/validator-set.js'
import { ByzantinePeer } from '../../../consensus/test/helpers.js'

export interface ByzantineTestNodeConfig {
  /** Unique string ID for this node (for orchestrator bookkeeping). */
  id: string
  /** 32-byte public key for this validator. */
  publicKey: Uint8Array
  /** This node's own transport. */
  transport: NetworkTransport
  /**
   * The deployment this node votes in. Vote signatures cover it, so a liar
   * that names the wrong chain produces signatures nobody accepts — which
   * tests nothing.
   */
  chainId: bigint
  /**
   * The validator set this node votes under; its `epoch()` is inside every
   * signed payload, for the same reason.
   */
  validators: ValidatorSet
  /**
   * Factory for a transport that reports an arbitrary sender id. Models a
   * transport that does not authenticate its peers — a relay, a gossip hub,
   * a signalling server forwarding a self-declared id. Needed for replay
   * attacks; see `ByzantinePeer`'s `spoof` option.
   */
  spoof?: (identity: Uint8Array) => NetworkTransport
}

export class ByzantineTestNode {
  readonly id: string
  readonly publicKey: Uint8Array
  readonly peer: ByzantinePeer

  constructor(config: ByzantineTestNodeConfig) {
    this.id = config.id
    this.publicKey = config.publicKey
    this.peer = new ByzantinePeer(config.publicKey, config.transport, {
      chainId: config.chainId,
      validators: config.validators,
      listen: true,
      spoof: config.spoof,
    })
  }

  /**
   * A Byzantine node never stops — that is what makes it Byzantine rather
   * than crashed. Present so it can sit alongside `RaijinTestNode` in
   * bookkeeping without special-casing.
   */
  get running(): boolean {
    return true
  }

  /**
   * Propose two different blocks at the same view and sequence to two
   * disjoint groups of peers, each backed by this node's own PREPARE (and,
   * by default, its COMMIT) so that each group sees a self-consistent round.
   *
   * Returns the consensus digest of each group's block, in order.
   */
  async equivocate(opts: {
    view: bigint
    sequence: bigint
    groups: Array<{ targets: Uint8Array[]; block: Block }>
    commit?: boolean
  }): Promise<Uint8Array[]> {
    return this.peer.equivocate(opts)
  }

  /** Everything this node overheard, in delivery order. */
  get received(): ReadonlyArray<{ from: Uint8Array; msg: unknown }> {
    return this.peer.received
  }
}
