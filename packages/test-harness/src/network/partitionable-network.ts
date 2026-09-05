/**
 * PartitionableNetwork — extends DeterministicNetwork's queue-and-deliver model
 * with partition/heal, delay injection, and probabilistic message drop.
 *
 * Unlike DeterministicNetwork.disconnect(), partition() is reversible:
 * peer handlers stay registered; only message delivery is blocked.
 */

import type { NetworkTransport, ConsensusMessage } from '@johnhenry/raijin-consensus'
import { SeededPRNG } from './seeded-prng.js'

type Handler = (from: Uint8Array, msg: ConsensusMessage) => Promise<void> | void

/** How `PartitionableNetwork.deliver()` chooses among ready messages. */
export type DeliveryOrder = 'fifo' | 'random'

/** One delivered message, as recorded in `PartitionableNetwork.deliveryLog`. */
export interface DeliveryRecord {
  from: string
  to: string
  type: ConsensusMessage['type']
}

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
  #deliveryOrder: DeliveryOrder = 'fifo'
  #deliveryLog: DeliveryRecord[] = []

  /** Set the PRNG for probabilistic message drops and seeded reordering. */
  setPRNG(prng: SeededPRNG): void {
    this.#prng = prng
  }

  /**
   * How `deliver()` picks among the messages that are ready to be delivered.
   *
   * `'fifo'` (the default, and the only behaviour this network had) always
   * takes the oldest deliverable message. That makes every run identical, but
   * it also means the suite only ever exercises ONE interleaving — and a
   * consensus protocol's interesting failures live in the interleavings. A
   * crash test passes under FIFO and says nothing about the other orderings.
   *
   * `'random'` picks uniformly among the currently-deliverable messages using
   * the seeded PRNG, so a seed names an interleaving and a failing seed
   * reproduces exactly. It requires `setPRNG` — without one it silently stays
   * FIFO, which would be a lie, so it throws instead.
   */
  setDeliveryOrder(order: DeliveryOrder): void {
    if (order === 'random' && !this.#prng) {
      throw new Error('setDeliveryOrder("random") requires setPRNG() first')
    }
    this.#deliveryOrder = order
  }

  /**
   * Every message delivered so far, in the order it was delivered.
   *
   * This is what makes "the same seed reproduces the same run" a checkable
   * claim rather than an assurance: two runs of the same scenario under the
   * same seed must produce identical logs, and two different seeds must not.
   */
  get deliveryLog(): readonly DeliveryRecord[] {
    return this.#deliveryLog
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
    // Collect what could be delivered right now (not blocked, not still
    // delayed, recipient not disconnected). Under 'fifo' that is just the
    // oldest such message. Under 'random' it is the oldest message *per
    // link*, and the PRNG picks among those.
    //
    // Per-link order is preserved on purpose. Every transport raijin is meant
    // to run on — an ordered WebRTC DataChannel, a WebSocket — delivers one
    // peer's messages to one peer in the order they were sent; what a real
    // network reorders is messages travelling on DIFFERENT links. Shuffling
    // within a link would model a transport nobody deploys, and it would
    // reorder a sender's own PRE-PREPARE behind its own PREPARE, which no
    // sender can do.
    const ready: number[] = []
    const seenLinks = new Set<string>()
    for (let i = 0; i < this.#queue.length; i++) {
      const item = this.#queue[i]
      if (item.deliverAfter > this.#now) continue
      if (this.#blocked.has(`${item.fromHex}:${item.to}`)) continue
      if (this.#disconnected.has(item.to)) continue
      if (this.#deliveryOrder === 'fifo') {
        ready.push(i)
        break
      }
      const link = `${item.fromHex}:${item.to}`
      if (seenLinks.has(link)) continue // keep this link's own order
      seenLinks.add(link)
      ready.push(i)
    }
    if (ready.length === 0) return false

    const chosen =
      this.#deliveryOrder === 'random' && this.#prng
        ? ready[this.#prng.nextInt(ready.length)]
        : ready[0]

    const [item] = this.#queue.splice(chosen, 1)
    this.#deliveryLog.push({
      from: item.fromHex,
      to: item.to,
      type: item.msg.type,
    })

    const handler = this.#peers.get(item.to)
    if (handler) {
      await handler(item.from, item.msg)
    }
    return true
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
