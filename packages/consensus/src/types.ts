/**
 * Consensus types for Raijin PBFT.
 */

import type { Block } from 'raijin-core'

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
}

export interface PrepareMessage {
  type: 'prepare'
  view: bigint
  sequence: bigint
  digest: Uint8Array
  from: Uint8Array
}

export interface CommitMessage {
  type: 'commit'
  view: bigint
  sequence: bigint
  digest: Uint8Array
  from: Uint8Array
  signature: Uint8Array
}

export interface ViewChangeMessage {
  type: 'view-change'
  newView: bigint
  sequence: bigint
  from: Uint8Array
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
