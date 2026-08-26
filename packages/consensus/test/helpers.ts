/**
 * Test helpers: mock transport, timer, and multi-peer simulation.
 */

import type { NetworkTransport, ConsensusMessage, ConsensusTimer, TimerHandle } from '../src/types.js'
import type { SignatureVerifier } from '@johnhenry/raijin-core'

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
