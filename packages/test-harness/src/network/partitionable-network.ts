/**
 * PartitionableNetwork — extends DeterministicNetwork's queue-and-deliver model
 * with partition/heal, delay injection, and probabilistic message drop.
 *
 * Unlike DeterministicNetwork.disconnect(), partition() is reversible:
 * peer handlers stay registered; only message delivery is blocked.
 */

import type { NetworkTransport, ConsensusMessage } from 'raijin-consensus'
import { SeededPRNG } from './seeded-prng.js'

type Handler = (from: Uint8Array, msg: ConsensusMessage) => Promise<void> | void

interface QueueItem {
  from: Uint8Array
  fromHex: string
  to: string
  msg: ConsensusMessage
  deliverAfter: number  // 0 = immediate, >0 = delayed until this timestamp
}

function toHex(data: Uint8Array): string {
  return Array.from(data).map(b => b.toString(16).padStart(2, '0')).join('')
}

// JSON bigint/Uint8Array helpers for deep-cloning messages
function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return { __bigint: value.toString() }
  if (value instanceof Uint8Array) return { __uint8array: Array.from(value) }
  return value
}
function reviver(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>
    if ('__bigint' in v) return BigInt(v.__bigint as string)
    if ('__uint8array' in v) return new Uint8Array(v.__uint8array as number[])
  }
  return value
}
function cloneMsg(msg: ConsensusMessage): ConsensusMessage {
  return JSON.parse(JSON.stringify(msg, replacer), reviver)
}

export class PartitionableNetwork {
  #peers = new Map<string, Handler>()
  #queue: QueueItem[] = []
  #blocked = new Set<string>()         // "fromHex:toHex" edge keys
  #disconnected = new Set<string>()    // fully disconnected peers (crash)
  #delays = new Map<string, number>()  // "fromHex:toHex" → ms delay
  #dropRates = new Map<string, number>() // "fromHex:toHex" → probability [0,1)
  #prng: SeededPRNG | null = null
  #now = 0  // logical time for delays

  /** Set the PRNG for probabilistic message drops */
  setPRNG(prng: SeededPRNG): void {
    this.#prng = prng
  }

  /** Create a transport for a peer */
  createTransport(peerId: Uint8Array): NetworkTransport {
    const peerHex = toHex(peerId)

    const transport: NetworkTransport = {
      broadcast: (msg: ConsensusMessage) => {
        if (this.#disconnected.has(peerHex)) return
        for (const [id] of this.#peers) {
          if (id !== peerHex && !this.#disconnected.has(id)) {
            this.#enqueue(peerId, peerHex, id, msg)
          }
        }
      },
      send: (to: Uint8Array, msg: ConsensusMessage) => {
        if (this.#disconnected.has(peerHex)) return
        const toHexStr = toHex(to)
        if (!this.#disconnected.has(toHexStr)) {
          this.#enqueue(peerId, peerHex, toHexStr, msg)
        }
      },
      onMessage: (handler: (from: Uint8Array, msg: ConsensusMessage) => void) => {
        this.#peers.set(peerHex, handler)
      },
    }

    return transport
  }

  #enqueue(from: Uint8Array, fromHex: string, toHex: string, msg: ConsensusMessage): void {
    const edgeKey = `${fromHex}:${toHex}`

    // Check drop rate
    const dropRate = this.#dropRates.get(edgeKey) ?? 0
    if (dropRate > 0 && this.#prng && this.#prng.nextBool(dropRate)) return

    // Check delay
    const delay = this.#delays.get(edgeKey) ?? 0
    const deliverAfter = delay > 0 ? this.#now + delay : 0

    this.#queue.push({
      from,
      fromHex,
      to: toHex,
      msg: cloneMsg(msg),
      deliverAfter,
    })
  }

  /** Deliver one queued message (if any is ready) */
  async deliver(): Promise<boolean> {
    // Find first deliverable message (not blocked, not delayed, not disconnected)
    for (let i = 0; i < this.#queue.length; i++) {
      const item = this.#queue[i]
      if (item.deliverAfter > this.#now) continue
      if (this.#blocked.has(`${item.fromHex}:${item.to}`)) continue
      if (this.#disconnected.has(item.to)) continue

      this.#queue.splice(i, 1)
      const handler = this.#peers.get(item.to)
      if (handler) {
        await handler(item.from, item.msg)
      }
      return true
    }
    return false
  }

  /** Deliver all ready messages */
  async drainAll(): Promise<number> {
    let count = 0
    while (await this.deliver()) count++
    return count
  }

  /** Number of messages currently queued */
  get pending(): number {
    return this.#queue.length
  }

  /** Advance logical time (makes delayed messages deliverable) */
  advanceTime(ms: number): void {
    this.#now += ms
  }

  // ── Fault injection ──

  /** Block messages between two groups (reversible with healPartition) */
  partition(groupA: Uint8Array[], groupB: Uint8Array[]): void {
    const hexA = groupA.map(toHex)
    const hexB = groupB.map(toHex)
    for (const a of hexA) {
      for (const b of hexB) {
        this.#blocked.add(`${a}:${b}`)
        this.#blocked.add(`${b}:${a}`)
      }
    }
  }

  /** Unblock all partitioned edges */
  healPartition(): void {
    this.#blocked.clear()
  }

  /** Permanently remove a peer (for crash simulation) */
  disconnect(peerId: Uint8Array): void {
    const hex = toHex(peerId)
    this.#disconnected.add(hex)
    this.#peers.delete(hex)
    // Remove queued messages to/from this peer
    this.#queue = this.#queue.filter(
      item => item.fromHex !== hex && item.to !== hex
    )
  }

  /** Re-register a peer that was disconnected (for restart) */
  reconnect(peerId: Uint8Array): NetworkTransport {
    const hex = toHex(peerId)
    this.#disconnected.delete(hex)
    return this.createTransport(peerId)
  }

  /** Add delay to messages on a specific edge */
  addDelay(from: Uint8Array, to: Uint8Array, ms: number): void {
    this.#delays.set(`${toHex(from)}:${toHex(to)}`, ms)
  }

  /** Remove delay from an edge */
  removeDelay(from: Uint8Array, to: Uint8Array): void {
    this.#delays.delete(`${toHex(from)}:${toHex(to)}`)
  }

  /** Set probabilistic message drop rate on an edge */
  addDropRate(from: Uint8Array, to: Uint8Array, rate: number): void {
    this.#dropRates.set(`${toHex(from)}:${toHex(to)}`, rate)
  }

  /** Remove drop rate */
  removeDropRate(from: Uint8Array, to: Uint8Array): void {
    this.#dropRates.delete(`${toHex(from)}:${toHex(to)}`)
  }

  /** Reset all fault injection */
  resetFaults(): void {
    this.#blocked.clear()
    this.#delays.clear()
    this.#dropRates.clear()
  }
}
