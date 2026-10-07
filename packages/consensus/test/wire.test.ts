import { describe, it, expect } from 'vitest'
import { encodeMessage, toHex, type Block, type Transaction, type GenesisConfig } from '@johnhenry/raijin-core'
import {
  encodeConsensusMessage,
  decodeConsensusMessage,
  codecTransport,
  type BytesTransport,
  type ConsensusMessage,
  type ViewChangeMessage,
} from '../src/index.js'

function prng(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (n: number) => Math.floor(next() * n)
  const bytes = (n: number) => Uint8Array.from({ length: n }, () => int(256))
  const big = () => {
    const pick = int(6)
    if (pick === 0) return 0n
    if (pick === 1) return 2n ** 64n - 1n
    if (pick === 2) return -BigInt(1 + int(1000))
    let v = 0n
    for (const b of bytes(1 + int(40))) v = (v << 8n) | BigInt(b)
    return v
  }
  return { int, bytes, big, next }
}
type R = ReturnType<typeof prng>

const tx = (r: R): Transaction => ({
  from: r.bytes(32), nonce: r.big(), to: r.int(4) === 0 ? null : r.bytes(32), value: r.big(),
  data: r.bytes(r.int(3) === 0 ? 0 : r.int(200)), signature: r.bytes(64), chainId: r.big(),
})
const block = (r: R): Block => ({
  header: {
    number: r.big(), parentHash: r.bytes(32), stateRoot: r.bytes(32), txRoot: r.bytes(32),
    receiptRoot: r.bytes(32), timestamp: Date.now() + r.int(1000), proposer: r.bytes(32),
  },
  transactions: Array.from({ length: r.int(6) }, () => tx(r)),
  signatures: Array.from({ length: r.int(5) }, () => r.bytes(64)),
})
const vc = (r: R): ViewChangeMessage => ({ type: 'view-change', newView: r.big(), sequence: r.big(), from: r.bytes(32), signature: r.bytes(64) })
const genesis = (r: R): GenesisConfig => ({
  chainId: r.big(),
  validators: Array.from({ length: 1 + r.int(7) }, () => r.bytes(32)),
  accounts: Array.from({ length: r.int(5) }, () => ({ address: r.bytes(32), balance: r.big(), nonce: r.int(2) ? r.big() : undefined })),
  timestamp: r.int(2) ? r.int(1e9) : undefined,
})

const generators: Record<ConsensusMessage['type'], (r: R) => ConsensusMessage> = {
  'pre-prepare': (r) => ({ type: 'pre-prepare', view: r.big(), sequence: r.big(), block: block(r), digest: r.bytes(32), from: r.bytes(32), signature: r.bytes(64) }),
  prepare: (r) => ({ type: 'prepare', view: r.big(), sequence: r.big(), digest: r.bytes(32), from: r.bytes(32), signature: r.bytes(64) }),
  commit: (r) => ({ type: 'commit', view: r.big(), sequence: r.big(), digest: r.bytes(32), from: r.bytes(32), signature: r.bytes(64) }),
  'view-change': vc,
  'new-view': (r) => ({ type: 'new-view', view: r.big(), viewChanges: Array.from({ length: r.int(6) }, () => vc(r)) }),
  'tx-gossip': (r) => ({ type: 'tx-gossip', tx: tx(r), hops: 1 + r.int(3) }),
  'genesis-request': () => ({ type: 'genesis-request' }),
  'genesis-response': (r) => ({ type: 'genesis-response', genesis: genesis(r) }),
}

// Compare ignoring `undefined` properties (the codec omits them, like JSON).
const strip = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_k, x) =>
  typeof x === 'bigint' ? { $b: x.toString() } : x instanceof Uint8Array ? { $u: toHex(x) } : x))

describe('consensus wire codec (property tests over every message type)', () => {
  for (const [type, gen] of Object.entries(generators)) {
    it(`round-trips ${type} x 150 seeds, canonically`, () => {
      for (let seed = 1; seed <= 150; seed++) {
        const msg = gen(prng(seed * 7919))
        const bytes = encodeConsensusMessage(msg)
        const back = decodeConsensusMessage(bytes)
        expect(strip(back), `${type} seed ${seed}`).toEqual(strip(msg))
        expect(back.type).toBe(type)
        expect(toHex(encodeConsensusMessage(back))).toBe(toHex(bytes))
      }
    })
  }

  it('edge values in votes: 0n, negative and huge bigints, empty digest', () => {
    for (const view of [0n, -1n, 2n ** 512n, -(2n ** 512n)]) {
      const msg: ConsensusMessage = { type: 'prepare', view, sequence: 0n, digest: new Uint8Array(0), from: new Uint8Array(0), signature: new Uint8Array(0) }
      expect(decodeConsensusMessage(encodeConsensusMessage(msg))).toStrictEqual(msg)
    }
  })

  it('a block with no transactions/signatures and an empty-data transaction round-trips', () => {
    const r = prng(1)
    const b = block(r)
    b.transactions = [{ ...tx(r), data: new Uint8Array(0), to: null, value: 0n, nonce: 0n }]
    b.signatures = []
    const msg: ConsensusMessage = { type: 'pre-prepare', view: 0n, sequence: 0n, block: b, digest: r.bytes(32), from: r.bytes(32), signature: r.bytes(64) }
    expect(decodeConsensusMessage(encodeConsensusMessage(msg))).toStrictEqual(msg)
  })

  it('rejects well-formed bytes that are not consensus messages', () => {
    const bad: unknown[] = [
      null, 5n, 'prepare', [], {}, { type: 'nope' },
      { type: 'prepare', view: 1, sequence: 1n, digest: new Uint8Array(1), from: new Uint8Array(1), signature: new Uint8Array(1) }, // number view
      { type: 'commit', view: 1n, sequence: 1n, digest: 'x', from: new Uint8Array(1), signature: new Uint8Array(1) },
      { type: 'pre-prepare', view: 1n, sequence: 1n, block: null, digest: new Uint8Array(1), from: new Uint8Array(1), signature: new Uint8Array(1) },
      { type: 'new-view', view: 1n, viewChanges: [{ type: 'prepare' }] },
      { type: 'tx-gossip', tx: {}, hops: 1n },
    ]
    for (const b of bad) expect(() => decodeConsensusMessage(encodeMessage(b))).toThrow(TypeError)
  })

  it('rejects corrupted bytes', () => {
    const bytes = encodeConsensusMessage(generators.commit(prng(3)))
    expect(() => decodeConsensusMessage(bytes.subarray(0, bytes.length - 1))).toThrow()
    expect(() => decodeConsensusMessage(new Uint8Array([...bytes, 0]))).toThrow()
  })
})

describe('codecTransport', () => {
  function pair() {
    const handlers: Array<(from: Uint8Array, bytes: Uint8Array) => void> = []
    const sent: Uint8Array[] = []
    const inner: BytesTransport = {
      broadcast: (b) => { sent.push(b) },
      send: (_to, b) => { sent.push(b) },
      onMessage: (h) => { handlers.push(h) },
    }
    return { inner, handlers, sent }
  }

  it('encodes outbound objects to bytes and decodes inbound bytes to objects', () => {
    const { inner, handlers, sent } = pair()
    const t = codecTransport(inner)
    const got: Array<[Uint8Array, ConsensusMessage]> = []
    t.onMessage((from, m) => got.push([from, m]))
    const msg = generators['tx-gossip'](prng(9))
    t.broadcast(msg)
    t.send(new Uint8Array(32), msg)
    expect(sent).toHaveLength(2)
    expect(sent[0]).toBeInstanceOf(Uint8Array)
    const from = new Uint8Array(32).fill(5)
    handlers[0](from, sent[0])
    expect(got).toHaveLength(1)
    expect(got[0][0]).toBe(from)
    expect(strip(got[0][1])).toEqual(strip(msg))
  })

  it('drops undecodable inbound payloads, reporting them via onError, never throwing', () => {
    const { inner, handlers } = pair()
    const errors: Error[] = []
    const t = codecTransport(inner, { onError: (e) => errors.push(e) })
    let delivered = 0
    t.onMessage(() => { delivered++ })
    expect(() => handlers[0](new Uint8Array(1), new Uint8Array([1, 2, 3]))).not.toThrow()
    expect(() => handlers[0](new Uint8Array(1), encodeMessage({ type: 'bogus' }))).not.toThrow()
    expect(delivered).toBe(0)
    expect(errors).toHaveLength(2)
  })

  it('takes the sender from the transport, not the payload', () => {
    const { inner, handlers } = pair()
    const t = codecTransport(inner)
    let seen: Uint8Array | null = null
    t.onMessage((from) => { seen = from })
    const m = generators.commit(prng(4)) as ConsensusMessage & { from: Uint8Array }
    handlers[0](new Uint8Array(32).fill(1), encodeConsensusMessage(m))
    expect(toHex(seen!)).toBe('01'.repeat(32))
    expect(toHex(seen!)).not.toBe(toHex(m.from))
  })
})
