/**
 * What `PartitionableNetwork` can actually do to a message.
 *
 * The harness advertises drop, delay, partition and (now) reordering, all
 * driven from a seed. Those claims are load-bearing — a Byzantine or
 * partition test is only worth the interleavings it covers, and "seed 1337
 * fails" is only a bug report if seed 1337 replays. Nothing measured them, so
 * this file does, against the network alone rather than through consensus:
 * a fault primitive that is broken should fail here, not show up three layers
 * up as a consensus round that mysteriously stalls.
 */

import { describe, it, expect } from 'vitest'

import type { ConsensusMessage } from '@johnhenry/raijin-consensus'
import { PartitionableNetwork } from '../src/network/partitionable-network.js'
import { SeededPRNG } from '../src/network/seeded-prng.js'
import { makeTestKey } from '../../consensus/test/helpers.js'

/** A message with just enough shape to travel. Contents are irrelevant here. */
function note(sequence: bigint): ConsensusMessage {
  return {
    type: 'prepare',
    view: 0n,
    sequence,
    digest: new Uint8Array(32),
    from: new Uint8Array(32),
    signature: new Uint8Array(0),
  }
}

/** Two peers, B recording what it receives. */
function pair(seed?: number) {
  const net = new PartitionableNetwork()
  if (seed !== undefined) net.setPRNG(new SeededPRNG(seed))
  const a = makeTestKey(1)
  const b = makeTestKey(2)
  const received: bigint[] = []
  const ta = net.createTransport(a)
  const tb = net.createTransport(b)
  tb.onMessage((_from, msg) => {
    received.push((msg as { sequence: bigint }).sequence)
  })
  // A must be registered too, or broadcasts have nowhere to go.
  net.createTransport(a).onMessage(() => {})
  return { net, a, b, ta, received }
}

describe('PartitionableNetwork fault primitives', () => {
  it('drops messages on an edge at the configured rate', async () => {
    const { net, a, b, ta, received } = pair(7)
    net.addDropRate(a, b, 1)
    for (let i = 0n; i < 10n; i++) ta.send(b, note(i))
    await net.drainAll()
    expect(received).toHaveLength(0)

    net.removeDropRate(a, b)
    for (let i = 0n; i < 10n; i++) ta.send(b, note(i))
    await net.drainAll()
    expect(received).toHaveLength(10)
  })

  it('drops the same messages on two runs of the same seed, and different ones on another', async () => {
    const run = async (seed: number): Promise<bigint[]> => {
      const { net, a, b, ta, received } = pair(seed)
      net.addDropRate(a, b, 0.5)
      for (let i = 0n; i < 40n; i++) ta.send(b, note(i))
      await net.drainAll()
      return received
    }
    const first = await run(7)
    expect(first.length).toBeGreaterThan(0)
    expect(first.length).toBeLessThan(40)
    expect(await run(7)).toEqual(first)
    expect(await run(8)).not.toEqual(first)
  })

  it('holds a delayed message until logical time reaches it', async () => {
    const { net, a, b, ta, received } = pair()
    net.addDelay(a, b, 500)
    ta.send(b, note(1n))

    expect(await net.drainAll()).toBe(0)
    expect(received).toHaveLength(0)
    expect(net.pending).toBe(1)

    net.advanceTime(499)
    expect(await net.drainAll()).toBe(0)
    expect(received).toHaveLength(0)

    net.advanceTime(1)
    expect(await net.drainAll()).toBe(1)
    expect(received).toEqual([1n])
  })

  it('blocks a partitioned edge in both directions and restores it on heal', async () => {
    const { net, a, b, ta, received } = pair()
    net.partition([a], [b])
    ta.send(b, note(1n))
    await net.drainAll()
    expect(received).toHaveLength(0)
    expect(net.pending).toBe(1) // held, not discarded — that is what makes it reversible

    net.healPartition()
    await net.drainAll()
    expect(received).toEqual([1n])
  })

  it('preserves each link own order while reordering across links', async () => {
    // Three senders into one receiver. Under 'random' the receiver may see
    // the senders interleaved in any order, but each sender's own messages
    // must arrive in the order that sender sent them — that is what an
    // ordered DataChannel or a WebSocket guarantees, and reordering a
    // sender behind itself would model a transport nobody deploys.
    const net = new PartitionableNetwork()
    net.setPRNG(new SeededPRNG(99))
    net.setDeliveryOrder('random')

    const dest = makeTestKey(9)
    const seen: string[] = []
    net.createTransport(dest).onMessage((from, msg) => {
      seen.push(`${from[0]}:${(msg as { sequence: bigint }).sequence}`)
    })

    for (const id of [1, 2, 3]) {
      const t = net.createTransport(makeTestKey(id))
      for (let i = 0n; i < 5n; i++) t.send(dest, note(i))
    }
    await net.drainAll()

    expect(seen).toHaveLength(15)
    for (const id of [1, 2, 3]) {
      const own = seen.filter((s) => s.startsWith(`${id}:`))
      expect(own, `sender ${id} out of order`).toEqual(
        [0, 1, 2, 3, 4].map((i) => `${id}:${i}`),
      )
    }
    // And the senders really were interleaved, or "preserves order" would be
    // a claim about a run that never reordered anything.
    const senderSequence = seen.map((s) => s[0]).join('')
    expect(senderSequence).not.toBe('111112222233333')
  })

  it('refuses seeded reordering without a seed rather than silently staying FIFO', () => {
    const net = new PartitionableNetwork()
    expect(() => net.setDeliveryOrder('random')).toThrow(/setPRNG/)
  })
})
