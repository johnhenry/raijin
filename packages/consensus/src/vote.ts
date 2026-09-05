/**
 * Domain-separated payloads for PBFT vote signatures.
 *
 * Every signature a validator produces must be usable in exactly one place:
 * one chain, one validator set, one phase, one view, one sequence, one block.
 * Signing a bare digest is not enough, and the failure is not subtle — if
 * PREPARE and COMMIT both sign `digest`, then a PREPARE, which is broadcast
 * to every peer, *is* a valid COMMIT from the same validator, and the commit
 * phase stops proving anything. Likewise, a signature that does not cover
 * `view`/`sequence` can be lifted into a later round unchanged.
 *
 * Two more scopes, for the same reason:
 *
 * - **`chainId`.** Without it, a vote is only ever a vote about "some block
 *   at view v, sequence s". Two deployments that share a validator — a
 *   testnet and a mainnet, a fork and its parent, two tenants of the same
 *   operator — can replay each other's votes verbatim, and each will count
 *   them toward its own quorum. This is the same hole `chainId` closes for
 *   transactions in the SDK, and it is closed the same way: no default. A
 *   default id is one every deployment that never chose shares.
 *
 * - **`epoch`.** A vote authorizes a decision by a *specific validator set*.
 *   Without the set in the signed bytes, votes survive membership changes: a
 *   validator that has been removed still has valid signatures lying on the
 *   wire, and those signatures keep counting toward the quorum of the set
 *   that removed them. Binding the epoch means a vote cast under one set is
 *   simply not a vote under any other.
 */

import { hash, encodeBigInt, encodeBytes } from '@johnhenry/raijin-core'

/** Which vote a signature authorizes. Part of the signed bytes. */
export type VotePhase = 'pre-prepare' | 'prepare' | 'commit' | 'view-change'

/**
 * Versioned domain tag per phase. Changing a tag invalidates old signatures.
 *
 * `v2` adds `chainId` and the validator-set `epoch` to the payload and moves
 * the integers to LEB128. The version is in the tag precisely so that a v1
 * signature cannot be replayed against a v2 payload by an implementation that
 * happens to reconstruct the rest of the fields.
 */
const DOMAIN_TAGS: Record<VotePhase, string> = {
  'pre-prepare': 'raijin/pbft/v2/pre-prepare',
  'prepare': 'raijin/pbft/v2/prepare',
  'commit': 'raijin/pbft/v2/commit',
  'view-change': 'raijin/pbft/v2/view-change',
}

const encoder = new TextEncoder()

/** A digest slot for votes that commit to no block (VIEW-CHANGE). */
export const NO_BLOCK_DIGEST = new Uint8Array(32)

/** Everything one vote is scoped to. All of it is signed. */
export interface Vote {
  /** Which vote this is. */
  phase: VotePhase
  /**
   * Chain identifier — which deployment this vote is about. Required: see
   * the note on `chainId` at the top of this file.
   */
  chainId: bigint
  /**
   * Validator-set epoch: an opaque identifier for the exact set (and order)
   * of validators this vote was cast under. `ValidatorSet#epoch()` produces
   * it; treat it as opaque bytes here.
   */
  epoch: Uint8Array
  /** The view this vote belongs to. */
  view: bigint
  /** The sequence number this vote belongs to. */
  sequence: bigint
  /** The block digest being voted on, or `NO_BLOCK_DIGEST` for VIEW-CHANGE. */
  digest: Uint8Array
}

/**
 * The bytes a validator signs for one vote.
 *
 * `H(tag ‖ 0x00 ‖ chainId ‖ epoch ‖ view ‖ sequence ‖ digest)`, where the
 * integers are LEB128 and `epoch`/`digest` are length-prefixed. Every field
 * is therefore self-delimiting, so no two distinct votes can produce the same
 * input — which is the whole property this function exists to provide. The
 * `0x00` separator keeps the variable-length tag from running into the first
 * field; no tag contains a zero byte.
 *
 * Takes a single object rather than positional arguments on purpose: four of
 * the six fields are bigints or byte strings of the same shape, and a
 * transposed pair would silently produce a valid-looking signature over the
 * wrong scope.
 *
 * Exported so that a transport, relay or test can construct and check a vote
 * without re-deriving the layout — there is one definition, and this is it.
 */
export async function voteDigest(vote: Vote): Promise<Uint8Array> {
  const tag = DOMAIN_TAGS[vote.phase]
  if (tag === undefined) {
    throw new TypeError(`voteDigest: unknown vote phase ${JSON.stringify(vote.phase)}`)
  }

  const chainId = requireIndex(vote.chainId, 'chainId')
  const view = requireIndex(vote.view, 'view')
  const sequence = requireIndex(vote.sequence, 'sequence')

  if (!(vote.epoch instanceof Uint8Array)) {
    throw new TypeError('voteDigest: epoch is required and must be a Uint8Array')
  }
  if (!(vote.digest instanceof Uint8Array)) {
    throw new TypeError('voteDigest: digest is required and must be a Uint8Array')
  }

  const payload = concat([
    encoder.encode(tag),
    new Uint8Array([0x00]),
    encodeBigInt(chainId),
    encodeBytes(vote.epoch),
    encodeBigInt(view),
    encodeBigInt(sequence),
    encodeBytes(vote.digest),
  ])

  return hash(payload)
}

/**
 * A bigint field that indexes into the protocol. Negative values are not
 * merely invalid, they collide: LEB128 encodes every negative to the same
 * empty string, so two different "views" would sign identical bytes.
 */
function requireIndex(value: bigint, name: string): bigint {
  if (typeof value !== 'bigint') {
    throw new TypeError(`voteDigest: ${name} is required and must be a bigint`)
  }
  if (value < 0n) {
    throw new RangeError(`voteDigest: ${name} must not be negative, got ${value}`)
  }
  return value
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0)
  const out = new Uint8Array(total)
  let pos = 0
  for (const part of parts) {
    out.set(part, pos)
    pos += part.length
  }
  return out
}
