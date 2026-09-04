import { describe, it, expect } from 'vitest'
import { ValidatorSet } from '../src/validator-set.js'
import { makeTestKey } from './helpers.js'

describe('ValidatorSet', () => {
  it('starts empty', () => {
    const vs = new ValidatorSet()
    expect(vs.size).toBe(0)
  })

  it('adds validators', () => {
    const vs = new ValidatorSet()
    expect(vs.add(makeTestKey(1))).toBe(true)
    expect(vs.add(makeTestKey(2))).toBe(true)
    expect(vs.size).toBe(2)
  })

  it('rejects duplicate validators', () => {
    const vs = new ValidatorSet()
    vs.add(makeTestKey(1))
    expect(vs.add(makeTestKey(1))).toBe(false)
    expect(vs.size).toBe(1)
  })

  it('removes validators', () => {
    const vs = new ValidatorSet()
    vs.add(makeTestKey(1))
    expect(vs.remove(makeTestKey(1))).toBe(true)
    expect(vs.size).toBe(0)
  })

  it('has() checks membership', () => {
    const vs = new ValidatorSet()
    vs.add(makeTestKey(1))
    expect(vs.has(makeTestKey(1))).toBe(true)
    expect(vs.has(makeTestKey(2))).toBe(false)
  })

  it('leaderForView rotates deterministically', () => {
    const vs = new ValidatorSet([makeTestKey(1), makeTestKey(2), makeTestKey(3)])
    const l0 = vs.leaderForView(0n)
    const l1 = vs.leaderForView(1n)
    const l2 = vs.leaderForView(2n)
    const l3 = vs.leaderForView(3n) // wraps around

    expect(l0).toEqual(makeTestKey(1))
    expect(l1).toEqual(makeTestKey(2))
    expect(l2).toEqual(makeTestKey(3))
    expect(l3).toEqual(makeTestKey(1)) // back to first
  })

  it('throws on leaderForView with empty set', () => {
    const vs = new ValidatorSet()
    expect(() => vs.leaderForView(0n)).toThrow('Empty')
  })

  describe('quorumSize', () => {
    it('returns 0 for empty set', () => {
      expect(new ValidatorSet().quorumSize()).toBe(0)
    })

    it('returns 1 for 1 validator (f=0)', () => {
      expect(new ValidatorSet([makeTestKey(1)]).quorumSize()).toBe(1)
    })

    it('returns 3 for 4 validators (f=1, quorum=2f+1=3)', () => {
      const vs = new ValidatorSet([makeTestKey(1), makeTestKey(2), makeTestKey(3), makeTestKey(4)])
      expect(vs.quorumSize()).toBe(3)
    })

    it('returns 5 for 7 validators (f=2, quorum=2f+1=5)', () => {
      const keys = Array.from({ length: 7 }, (_, i) => makeTestKey(i + 1))
      expect(new ValidatorSet(keys).quorumSize()).toBe(5)
    })

    const setOf = (n: number) =>
      new ValidatorSet(Array.from({ length: n }, (_, i) => makeTestKey(i + 1)))

    // The four sizes above are all n = 3f + 1, where the old `2f + 1` formula
    // happened to be right. These are the sizes it was wrong for. See #19.
    it('never lets a single node reach quorum in a multi-node set', () => {
      for (let n = 2; n <= 24; n++) {
        expect(setOf(n).quorumSize()).toBeGreaterThan(1)
      }
    })

    it('guarantees any two quorums share at least one honest node, for every n', () => {
      for (let n = 1; n <= 60; n++) {
        const vs = setOf(n)
        const q = vs.quorumSize()
        const f = vs.maxFaults
        // Two quorums overlap in at least 2q - n nodes; at most f of those can
        // be Byzantine, so safety needs 2q - n >= f + 1.
        expect(2 * q - n).toBeGreaterThanOrEqual(f + 1)
        // And a quorum must be reachable when the tolerated faults are absent.
        expect(q).toBeLessThanOrEqual(n - f)
      }
    })

    it('still equals 2f + 1 at every canonical n = 3f + 1', () => {
      for (let f = 0; f <= 12; f++) {
        const n = 3 * f + 1
        expect(setOf(n).quorumSize()).toBe(2 * f + 1)
      }
    })
  })

  it('maxFaults returns floor((n-1)/3)', () => {
    expect(new ValidatorSet([makeTestKey(1)]).maxFaults).toBe(0)
    expect(new ValidatorSet(Array.from({ length: 4 }, (_, i) => makeTestKey(i))).maxFaults).toBe(1)
    expect(new ValidatorSet(Array.from({ length: 7 }, (_, i) => makeTestKey(i))).maxFaults).toBe(2)
  })

  it('constructs with initial validators', () => {
    const vs = new ValidatorSet([makeTestKey(1), makeTestKey(2)])
    expect(vs.size).toBe(2)
    expect(vs.has(makeTestKey(1))).toBe(true)
    expect(vs.has(makeTestKey(2))).toBe(true)
  })
})
