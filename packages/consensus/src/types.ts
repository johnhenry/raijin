/**
 * Consensus types for Raijin PBFT.
 */

import type { Block } from '@johnhenry/raijin-core'

// ── Network transport interface ───────────────────────────────────────

/** Transport-agnostic message sending. Implement with WebRTC, WebSocket, etc. */
export interface NetworkTransport {
  /** Broadcast a message to all peers. */
  broadcast(message: ConsensusMessage): void
  /** Send a message to a specific peer. */
  send(to: Uint8Array, message: ConsensusMessage): void
  /** Register a handler for incoming messages. */
  onMessage(handler: (from: Uint8Array, msg: ConsensusMessage) => void): void
}

// ── Timer interface (injectable for testing) ──────────────────────────

export interface ConsensusTimer {
  set(ms: number, callback: () => void): TimerHandle
  clear(handle: TimerHandle): void
}

export type TimerHandle = unknown

// ── Consensus messages ────────────────────────────────────────────────

export type ConsensusMessage =
  | PrePrepareMessage
  | PrepareMessage
  | CommitMessage
  | ViewChangeMessage
  | NewViewMessage

export interface PrePrepareMessage {
  type: 'pre-prepare'
  view: bigint
  sequence: bigint
  block: Block
  digest: Uint8Array
  /** The proposing leader's public key. */
  from: Uint8Array
  /** Signature over `voteDigest('pre-prepare', view, sequence, digest)`, by
   *  `from`. Verified before the proposal is accepted — without it, a proposal
   *  is authenticated only by whatever `from` the transport supplies, so any
   *  transport that does not itself authenticate peers (a relay, a gossip hub,
   *  a signalling server forwarding a self-declared id) could inject blocks. */
  signature: Uint8Array
}

export interface PrepareMessage {
  type: 'prepare'
  view: bigint
  sequence: bigint
  digest: Uint8Array
  from: Uint8Array
  /** Signature over `voteDigest('prepare', view, sequence, digest)`, by `from`.
   *  Verified before counting toward quorum. The phase tag, view and sequence
   *  are inside the signed bytes so the vote cannot be replayed as a COMMIT,
   *  or into another view or sequence. */
  signature: Uint8Array
}

export interface CommitMessage {
  type: 'commit'
  view: bigint
  sequence: bigint
  digest: Uint8Array
  from: Uint8Array
  /** Signature over `voteDigest('commit', view, sequence, digest)`, by `from`. */
  signature: Uint8Array
}

export interface ViewChangeMessage {
  type: 'view-change'
  newView: bigint
  sequence: bigint
  from: Uint8Array
  /** Signature over `voteDigest('view-change', newView, sequence,
   *  NO_BLOCK_DIGEST)`, by `from`. Verified before counting toward a NEW-VIEW
   *  quorum. Replay of an old VIEW-CHANGE is stopped by the monotonic view
   *  check in the handler, not by the signature. */
  signature: Uint8Array
}

export interface NewViewMessage {
  type: 'new-view'
  view: bigint
  viewChanges: ViewChangeMessage[]
}

// ── PBFT phase ────────────────────────────────────────────────────────

export enum PBFTPhase {
  Idle = 'idle',
  PrePrepared = 'pre-prepared',
  Prepared = 'prepared',
  Committed = 'committed',
}
