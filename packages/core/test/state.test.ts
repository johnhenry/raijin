import { describe, it, expect } from 'vitest'
import { InMemoryStateStore, StateMachine, equal, toHex, fromHex } from '../src/index.js'

const encoder = new TextEncoder()

async function storeWith(entries: [Uint8Array, Uint8Array][]): Promise<InMemoryStateStore> {
  const store = new InMemoryStateStore()
  for (const [key, value] of entries) await store.put(key, value)
  return store
}

describe('InMemoryStateStore.root', () => {
  it('gives two different states two different roots when a byte moves across the key/value boundary', async () => {
    // The state root used to be `H(key0 || value0 || key1 || value1 || ...)`
    // over hex-encoded keys and raw values, with no length prefix on either.
    // Nothing then marked where a key stopped and its value began, so bytes
    // could be shifted across that boundary and the concatenation — and the
    // root — stayed identical.
    //
    // Here: one entry under key 0xab whose value is the two ASCII bytes "cd",
    // versus one entry under key 0xabcd with an empty value. Both used to
    // flatten to the bytes 61 62 63 64 ("abcd").
    const a = await storeWith([[fromHex('ab'), encoder.encode('cd')]])
    const b = await storeWith([[fromHex('abcd'), new Uint8Array(0)]])

    expect(equal(await a.root(), await b.root())).toBe(false)

    // The same attack stated against the *current* encoding, which hashes raw
    // key bytes rather than their hex text: a one-byte key with a one-byte
    // value versus a two-byte key with an empty value. Only the length
    // prefixes keep these apart.
    const c = await storeWith([[fromHex('ab'), fromHex('cd')]])
    const d = await storeWith([[fromHex('abcd'), new Uint8Array(0)]])

    expect(equal(await c.root(), await d.root())).toBe(false)
  })

  it('gives two states with different account boundaries different roots', async () => {
    // The same defect with two entries each, which is the shape a real store
    // has: state keys are `namespace + id` and namespaces differ in length
    // ('account:' is 8 bytes, 'credential:' is 11), while values are
    // variable-length LEB128 records. Adjacent entries could therefore trade
    // bytes between key and value and leave the root unchanged.
    const a = await storeWith([
      [fromHex('61'), encoder.encode('62')],
      [fromHex('63'), encoder.encode('64')],
    ])
    const b = await storeWith([
      [fromHex('6162'), new Uint8Array(0)],
      [fromHex('6364'), new Uint8Array(0)],
    ])

    expect(equal(await a.root(), await b.root())).toBe(false)
  })

  it('separates the empty state from every non-empty state', async () => {
    const empty = new InMemoryStateStore()
    const one = await storeWith([[fromHex('00'), new Uint8Array(0)]])

    expect(equal(await empty.root(), await one.root())).toBe(false)
    // Stable across calls — the root is a function of the contents alone.
    expect(toHex(await empty.root())).toBe(toHex(await new InMemoryStateStore().root()))
  })

  it('is insertion-order independent but content sensitive', async () => {
    const forward = await storeWith([
      [fromHex('01'), encoder.encode('one')],
      [fromHex('02'), encoder.encode('two')],
    ])
    const reverse = await storeWith([
      [fromHex('02'), encoder.encode('two')],
      [fromHex('01'), encoder.encode('one')],
    ])
    expect(toHex(await forward.root())).toBe(toHex(await reverse.root()))

    await reverse.put(fromHex('02'), encoder.encode('TWO'))
    expect(equal(await forward.root(), await reverse.root())).toBe(false)
  })

  it('returns to the earlier root after a revert', async () => {
    const store = new InMemoryStateStore()
    await store.put(fromHex('01'), encoder.encode('one'))
    const before = await store.root()

    const snapshot = await store.snapshot()
    await store.put(fromHex('02'), encoder.encode('two'))
    expect(equal(await store.root(), before)).toBe(false)

    await store.revert(snapshot)
    expect(equal(await store.root(), before)).toBe(true)
  })

  it('distinguishes two account sets that differ only in where a key ends', async () => {
    // Reached through the public state API rather than raw byte keys: two
    // stores holding accounts under keys of different lengths. This is what a
    // divergent chain would have looked like — two different sets of balances
    // producing one stateRoot, so the header agreed on nothing.
    const verifier = { async verify() { return true } }
    const a = new InMemoryStateStore()
    const b = new InMemoryStateStore()
    const smA = new StateMachine(a, verifier)
    const smB = new StateMachine(b, verifier)

    // Store A: the account id ends at 'x', and the record's first bytes are
    // the ASCII text "61". Store B: the id is one byte longer (0x61 = 'a')
    // and the record is empty. Keys are hex-stringified before hashing, so
    // A's value bytes were byte-identical to B's extra key nibble pair.
    await a.put(encoder.encode('account:x'), encoder.encode('61'))
    await b.put(encoder.encode('account:xa'), new Uint8Array(0))

    // `stateRoot()` is exactly what goes into the block header.
    expect(equal(await smA.stateRoot(), await smB.stateRoot())).toBe(false)
  })
})
