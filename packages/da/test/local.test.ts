import { describe, it, expect, beforeEach } from 'vitest'
import { LocalDA } from '../src/local.js'
import { hash, equal, toHex } from 'raijin-core'

const encoder = new TextEncoder()

describe('LocalDA', () => {
  let da: LocalDA

  beforeEach(() => {
    da = new LocalDA()
  })

  it('has name "local"', () => {
    expect(da.name).toBe('local')
  })

  it('submit returns a valid commitment', async () => {
    const data = encoder.encode('hello raijin')
    const commitment = await da.submit(data)

    expect(commitment.layer).toBe('local')
    expect(commitment.height).toBe(0n)
    expect(commitment.index).toBe(0)
    expect(commitment.hash).toBeInstanceOf(Uint8Array)
    expect(commitment.hash.length).toBe(32) // SHA-256

    // Hash should match what we'd compute independently
    const expected = await hash(data)
    expect(equal(commitment.hash, expected)).toBe(true)
  })

  it('retrieve returns the original data', async () => {
    const data = encoder.encode('retrieve me')
    const commitment = await da.submit(data)
    const retrieved = await da.retrieve(commitment)

    expect(equal(retrieved, data)).toBe(true)
  })

  it('retrieve throws for unknown commitment', async () => {
    const fakeCommitment = {
      layer: 'local',
      height: 0n,
      index: 0,
      hash: new Uint8Array(32), // all zeros — never submitted
    }

    await expect(da.retrieve(fakeCommitment)).rejects.toThrow('no data found')
  })

  it('verify returns true for valid commitment', async () => {
    const data = encoder.encode('verify me')
    const commitment = await da.submit(data)

    expect(await da.verify(commitment)).toBe(true)
  })

  it('verify returns false for unknown hash', async () => {
    const fakeCommitment = {
      layer: 'local',
      height: 0n,
      index: 0,
      hash: new Uint8Array(32),
    }

    expect(await da.verify(fakeCommitment)).toBe(false)
  })

  it('increments index for multiple submissions in same block', async () => {
    const c1 = await da.submit(encoder.encode('first'))
    const c2 = await da.submit(encoder.encode('second'))
    const c3 = await da.submit(encoder.encode('third'))

    expect(c1.index).toBe(0)
    expect(c2.index).toBe(1)
    expect(c3.index).toBe(2)
    expect(c1.height).toBe(c2.height)
  })

  it('nextBlock advances height and resets index', async () => {
    await da.submit(encoder.encode('block 0 blob'))
    da.nextBlock()
    const c = await da.submit(encoder.encode('block 1 blob'))

    expect(c.height).toBe(1n)
    expect(c.index).toBe(0)
  })

  it('stores defensive copies (mutations do not affect store)', async () => {
    const data = encoder.encode('immutable')
    const commitment = await da.submit(data)

    // Mutate original
    data[0] = 0xff

    const retrieved = await da.retrieve(commitment)
    expect(retrieved[0]).not.toBe(0xff)
  })

  it('clear removes all data and resets counters', async () => {
    await da.submit(encoder.encode('a'))
    await da.submit(encoder.encode('b'))
    expect(da.size).toBe(2)

    da.clear()
    expect(da.size).toBe(0)

    const c = await da.submit(encoder.encode('c'))
    expect(c.height).toBe(0n)
    expect(c.index).toBe(0)
  })

  it('deduplicates identical data by hash', async () => {
    const data = encoder.encode('same data')
    await da.submit(data)
    await da.submit(data)

    // Same content hashes to same key, so store size is 1
    expect(da.size).toBe(1)
  })
})
