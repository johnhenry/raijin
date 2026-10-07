/**
 * Wire boundary for `NetworkTransport`s that move bytes.
 *
 * `NetworkTransport` is typed over `ConsensusMessage` objects, which carry
 * `bigint` and `Uint8Array` and so cannot be `JSON.stringify`d. A transport
 * that crosses a process boundary (WebSocket, WebRTC data channel, wsh
 * stream, ...) implements the smaller `BytesTransport` instead and is wrapped
 * with `codecTransport`, which encodes on send and decodes on receive with
 * the canonical codec from `@johnhenry/raijin-core` (`encodeMessage`).
 * In-process transports that pass objects keep working unchanged.
 */

import { encodeMessage, decodeMessage } from '@johnhenry/raijin-core'
import type { ConsensusMessage, NetworkTransport } from './types.js'

/**
 * The contract a real network transport implements. It only moves opaque
 * bytes; it must deliver each message intact and in order per peer, and must
 * hand `onMessage` the AUTHENTICATED sender public key (the transport, not
 * the payload, is what binds a `from` to a connection -- see below).
 */
export interface BytesTransport {
  /** Send `bytes` to every connected peer (not to self). */
  broadcast(bytes: Uint8Array): void
  /** Send `bytes` to the peer whose public key is `to`. Unknown peer: drop silently. */
  send(to: Uint8Array, bytes: Uint8Array): void
  /** Register the (single) handler for inbound bytes from authenticated peer `from`. */
  onMessage(handler: (from: Uint8Array, bytes: Uint8Array) => void): void
}

export interface CodecTransportOptions {
  /** Called with each inbound payload that fails to decode or validate. It is always dropped. */
  onError?: (error: Error, from: Uint8Array) => void
}

const isBytes = (v: unknown): v is Uint8Array => v instanceof Uint8Array
const isBig = (v: unknown): v is bigint => typeof v === 'bigint'
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !isBytes(v)

function bad(why: string): never {
  throw new TypeError(`consensus message: ${why}`)
}

function checkVote(m: Record<string, unknown>, viewField: string): void {
  if (!isBig(m[viewField])) bad(`${viewField} must be a bigint`)
  if (!isBig(m.sequence)) bad('sequence must be a bigint')
  if (!isBytes(m.from)) bad('from must be bytes')
  if (!isBytes(m.signature)) bad('signature must be bytes')
}

function checkViewChange(m: unknown): void {
  if (!isObj(m) || m.type !== 'view-change') bad('viewChanges must hold view-change messages')
  checkVote(m, 'newView')
}

/** Shape-check a decoded value as a `ConsensusMessage` (throws `TypeError`). */
function assertConsensusMessage(m: unknown): asserts m is ConsensusMessage {
  if (!isObj(m) || typeof m.type !== 'string') bad('missing type')
  switch (m.type) {
    case 'pre-prepare':
      checkVote(m, 'view')
      if (!isBytes(m.digest)) bad('digest must be bytes')
      if (!isObj(m.block) || !isObj(m.block.header) || !Array.isArray(m.block.transactions)) bad('malformed block')
      return
    case 'prepare':
    case 'commit':
      checkVote(m, 'view')
      if (!isBytes(m.digest)) bad('digest must be bytes')
      return
    case 'view-change':
      checkVote(m, 'newView')
      return
    case 'new-view':
      if (!isBig(m.view)) bad('view must be a bigint')
      if (!Array.isArray(m.viewChanges)) bad('viewChanges must be an array')
      m.viewChanges.forEach(checkViewChange)
      return
    case 'tx-gossip':
      if (!isObj(m.tx)) bad('tx must be an object')
      if (typeof m.hops !== 'number') bad('hops must be a number')
      return
    case 'genesis-request':
      return
    case 'genesis-response':
      if (!isObj(m.genesis)) bad('genesis must be an object')
      return
    default:
      bad(`unknown type ${JSON.stringify(m.type)}`)
  }
}

/** Canonical wire bytes of a consensus message (see `encodeMessage` in core). */
export function encodeConsensusMessage(msg: ConsensusMessage): Uint8Array {
  return encodeMessage(msg)
}

/**
 * Decode and shape-check a consensus message. Throws `WireFormatError` (bad
 * bytes) or `TypeError` (well-formed bytes that are not a consensus message).
 * Signatures are NOT checked here; `PBFTConsensus` verifies those.
 */
export function decodeConsensusMessage(bytes: Uint8Array): ConsensusMessage {
  const m = decodeMessage<unknown>(bytes)
  assertConsensusMessage(m)
  return m
}

/**
 * Adapt a bytes-only transport to the object-typed `NetworkTransport` that
 * `PBFTConsensus` and `ValidatorNode` take. Inbound payloads that fail to
 * decode are dropped (reported through `onError`), never thrown into the
 * transport.
 *
 * Security note: `from` is whatever the inner transport authenticated; the
 * codec never reads a sender out of the payload.
 */
export function codecTransport(inner: BytesTransport, opts: CodecTransportOptions = {}): NetworkTransport {
  return {
    broadcast: (message) => inner.broadcast(encodeConsensusMessage(message)),
    send: (to, message) => inner.send(to, encodeConsensusMessage(message)),
    onMessage: (handler) => {
      inner.onMessage((from, bytes) => {
        let msg: ConsensusMessage
        try {
          msg = decodeConsensusMessage(bytes)
        } catch (e) {
          opts.onError?.(e instanceof Error ? e : new Error(String(e)), from)
          return
        }
        // Return the handler's promise: some transports await delivery.
        return handler(from, msg) as unknown as void
      })
    },
  }
}
