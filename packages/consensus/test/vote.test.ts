/**
 * What a vote signature is scoped to.
 *
 * These assert relational properties — "these two votes must not sign the
 * same bytes" — rather than pinning digests to literals. A literal would fix
 * a second definition of the payload layout alongside the shipped one, which
 * is the failure mode `pbft.test.ts`'s old hand-copied `computeDigest` had:
 * it kept passing while agreeing with an encoder nobody ran.
 */

import { describe, it, expect } from 'vitest'
import { voteDigest, NO_BLOCK_DIGEST, type VotePhase } from '../src/vote.js'
import { ValidatorSet } from '../src/validator-set.js'
import { makeTestKey } from './helpers.js'

const EPOCH_A = new Uint8Array(32).fill(0xa1)
const EPOCH_B = new Uint8Array(32).fill(0xb2)
const DIGEST = new Uint8Array(32).fill(0x0d)

/** A baseline vote; each test varies exactly one field of it. */
function vote(overrides: Partial<Parameters<typeof voteDigest>[0]> = {}) {
  return {
    phase: 'prepare' as VotePhase,
    chainId: 1n,
    epoch: EPOCH_A,
    view: 3n,
    sequence: 7n,
    digest: DIGEST,
    ...overrides,
  }
}

const hex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('')

describe('voteDigest', () => {
  it('is deterministic for the same vote', async () => {
    expect(hex(await voteDigest(vote()))).toBe(hex(await voteDigest(vote())))
  })

  // ── chainId ─────────────────────────────────────────────────────────
  //
  // Without chainId a vote says only "some block at view v, sequence s".
  // Two deployments sharing a validator — a testnet and a mainnet, a fork and
  // its parent — replay each other's votes verbatim and each counts them
  // toward its own quorum. See issue #25.
  describe('binds a vote to its chain', () => {
    it('gives two chains different signed bytes for the same vote', async () => {
      const onChain1 = await voteDigest(vote({ chainId: 1n }))
      const onChain2 = await voteDigest(vote({ chainId: 2n }))
      expect(hex(onChain1)).not.toBe(hex(onChain2))
    })

    it('separates adjacent chain ids, not just distant ones', async () => {
      const a = await voteDigest(vote({ chainId: 0n }))
      const b = await voteDigest(vote({ chainId: 1n }))
      expect(hex(a)).not.toBe(hex(b))
    })

    it('requires a chainId — there is no default', async () => {
      await expect(
        voteDigest(vote({ chainId: undefined as unknown as bigint })),
      ).rejects.toThrow(/chainId is required/)
    })

    it('refuses a negative chainId rather than collapsing it', async () => {
      // LEB128 encodes every negative bigint to the same empty string, so an
      // unchecked negative would make distinct scopes sign identical bytes.
      await expect(voteDigest(vote({ chainId: -1n }))).rejects.toThrow(/must not be negative/)
    })
  })

  // ── epoch ───────────────────────────────────────────────────────────
  //
  // A vote authorizes a decision by a *specific* validator set. Without the
  // set in the signed bytes, a validator removed from it still has valid
  // signatures on the wire that keep counting toward the new set's quorum.
  describe('binds a vote to its validator-set epoch', () => {
    it('gives two epochs different signed bytes for the same vote', async () => {
      const underA = await voteDigest(vote({ epoch: EPOCH_A }))
      const underB = await voteDigest(vote({ epoch: EPOCH_B }))
      expect(hex(underA)).not.toBe(hex(underB))
    })

    it('requires an epoch', async () => {
      await expect(
        voteDigest(vote({ epoch: undefined as unknown as Uint8Array })),
      ).rejects.toThrow(/epoch is required/)
    })

    it('keeps the epoch boundary distinct from the fields around it', async () => {
      // `epoch` is variable-length, and the fields after it are LEB128
      // integers — which are self-delimiting only once you know where they
      // start. Drop the length prefix and the start becomes ambiguous, so
      // bytes from the epoch can be read as the view, and bytes from the
      // sequence as the digest.
      //
      // These two votes are genuinely different — different epoch, view,
      // sequence and digest — and with an unprefixed layout both flatten to
      //
      //   01 aa 03 07 01 ff
      //
      // i.e. one signature that authorizes both. Constructed by hand rather
      // than by picking lengths that look suspicious: a witness that does not
      // actually collide under the broken layout is a test that can never
      // fail for the reason it names.
      const a = await voteDigest(vote({
        chainId: 1n,
        epoch: new Uint8Array([0xaa, 0x03]),
        view: 7n,
        sequence: 1n,
        digest: new Uint8Array([0xff]),
      }))
      const b = await voteDigest(vote({
        chainId: 1n,
        epoch: new Uint8Array([0xaa]),
        view: 3n,
        sequence: 7n,
        digest: new Uint8Array([0x01, 0xff]),
      }))
      expect(hex(a)).not.toBe(hex(b))
    })
  })

  // ── the scopes that were already there ──────────────────────────────
  //
  // Regression cover: adding chainId and epoch must not have loosened the
  // separation that was already load-bearing.
  describe('still binds phase, view and sequence', () => {
    it('separates PREPARE from COMMIT', async () => {
      const prepare = await voteDigest(vote({ phase: 'prepare' }))
      const commit = await voteDigest(vote({ phase: 'commit' }))
      expect(hex(prepare)).not.toBe(hex(commit))
    })

    it('separates every phase from every other', async () => {
      const phases: VotePhase[] = ['pre-prepare', 'prepare', 'commit', 'view-change']
      const digests = await Promise.all(phases.map(phase => voteDigest(vote({ phase }))))
      expect(new Set(digests.map(hex)).size).toBe(phases.length)
    })

    it('separates views and sequences', async () => {
      const base = hex(await voteDigest(vote()))
      expect(hex(await voteDigest(vote({ view: 4n })))).not.toBe(base)
      expect(hex(await voteDigest(vote({ sequence: 8n })))).not.toBe(base)
    })

    it('does not confuse a view with a sequence', async () => {
      // (view 3, seq 7) and (view 7, seq 3) are different rounds.
      const a = await voteDigest(vote({ view: 3n, sequence: 7n }))
      const b = await voteDigest(vote({ view: 7n, sequence: 3n }))
      expect(hex(a)).not.toBe(hex(b))
    })

    it('rejects an unknown phase', async () => {
      await expect(
        voteDigest(vote({ phase: 'commit ' as VotePhase })),
      ).rejects.toThrow(/unknown vote phase/)
    })
  })

  it('accepts NO_BLOCK_DIGEST for a view change', async () => {
    const d = await voteDigest(vote({ phase: 'view-change', digest: NO_BLOCK_DIGEST }))
    expect(d.length).toBe(32)
  })
})

describe('ValidatorSet.epoch', () => {
  const [k1, k2, k3] = [makeTestKey(1), makeTestKey(2), makeTestKey(3)]

  it('is stable for an unchanged set', async () => {
    const set = new ValidatorSet([k1, k2, k3])
    expect(hex(await set.epoch())).toBe(hex(await set.epoch()))
  })

  it('agrees between two independently built sets with the same members', async () => {
    // Two nodes that hold the same set must sign the same bytes, or nothing
    // reaches quorum.
    const a = new ValidatorSet([k1, k2, k3])
    const b = new ValidatorSet([k1, k2, k3])
    expect(hex(await a.epoch())).toBe(hex(await b.epoch()))
  })

  it('changes when a validator is removed', async () => {
    // The property the epoch exists for: the removed validator's old
    // signatures were made under a different epoch, so they cannot be
    // counted toward the quorum of the set that removed them.
    const set = new ValidatorSet([k1, k2, k3])
    const before = hex(await set.epoch())

    expect(set.remove(k2)).toBe(true)
    expect(hex(await set.epoch())).not.toBe(before)
  })

  it('changes when a validator is added', async () => {
    const set = new ValidatorSet([k1, k2])
    const before = hex(await set.epoch())

    expect(set.add(k3)).toBe(true)
    expect(hex(await set.epoch())).not.toBe(before)
  })

  it('does not change when a no-op add is rejected', async () => {
    const set = new ValidatorSet([k1, k2])
    const before = hex(await set.epoch())

    expect(set.add(k1)).toBe(false) // already present
    expect(hex(await set.epoch())).toBe(before)
  })

  it('distinguishes two sets that differ only in order', async () => {
    // `leaderForView` picks by index, so the same members in a different
    // order elect different leaders — genuinely a different set.
    const a = new ValidatorSet([k1, k2, k3])
    const b = new ValidatorSet([k3, k2, k1])
    expect(hex(await a.epoch())).not.toBe(hex(await b.epoch()))
  })

  it('distinguishes sets whose keys differ only in where one ends', async () => {
    // Concatenating keys without a length prefix loses the boundary between
    // them: [0xaa, 0xbbcc] and [0xaabb, 0xcc] flatten to the same bytes.
    const a = new ValidatorSet([new Uint8Array([0xaa]), new Uint8Array([0xbb, 0xcc])])
    const b = new ValidatorSet([new Uint8Array([0xaa, 0xbb]), new Uint8Array([0xcc])])
    expect(hex(await a.epoch())).not.toBe(hex(await b.epoch()))
  })

  it('gives the empty set an epoch of its own', async () => {
    const empty = new ValidatorSet()
    const one = new ValidatorSet([k1])
    expect(hex(await empty.epoch())).not.toBe(hex(await one.epoch()))
  })
})
