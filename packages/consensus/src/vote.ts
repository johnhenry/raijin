/**
 * Domain-separated payloads for PBFT vote signatures.
 *
 * Every signature a validator produces must be usable in exactly one place:
 * one phase, one view, one sequence, one block. Signing a bare digest is not
 * enough, and the failure is not subtle — if PREPARE and COMMIT both sign
 * `digest`, then a PREPARE, which is broadcast to every peer, *is* a valid
 * COMMIT from the same validator, and the commit phase stops proving anything.
 * Likewise, a signature that does not cover `view`/`sequence` can be lifted
 * into a later round unchanged.
 */

import { hash } from '@johnhenry/raijin-core'

/** Which vote a signature authorizes. Part of the signed bytes. */
export type VotePhase = 'pre-prepare' | 'prepare' | 'commit' | 'view-change'

/** Versioned domain tag per phase. Changing a tag invalidates old signatures. */
const DOMAIN_TAGS: Record<VotePhase, string> = {
  'pre-prepare': 'raijin/pbft/v1/pre-prepare',
  'prepare': 'raijin/pbft/v1/prepare',
  'commit': 'raijin/pbft/v1/commit',
  'view-change': 'raijin/pbft/v1/view-change',
}

const encoder = new TextEncoder()

/** Big-endian 8-byte encoding of a bigint, matching the block-header codec. */
function bigintToBytes(value: bigint): Uint8Array {
  const hex = value.toString(16).padStart(16, '0')
  const bytes = new Uint8Array(8)
  for (let i = 0; i < 8; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

/** A digest slot for votes that commit to no block (VIEW-CHANGE). */
export const NO_BLOCK_DIGEST = new Uint8Array(32)

/**
 * The bytes a validator signs for one vote.
 *
 * `H(tag || 0x00 || view || sequence || digest)`. The `0x00` separator keeps
 * the variable-length tag from running into the fixed-width fields, so no two
 * distinct (phase, view, sequence, digest) tuples can produce the same input.
 *
 * Exported so that a transport, relay or test can construct and check a vote
 * without re-deriving the layout — there is one definition, and this is it.
 */
export async function voteDigest(
  phase: VotePhase,
  view: bigint,
  sequence: bigint,
  digest: Uint8Array,
): Promise<Uint8Array> {
  const tag = encoder.encode(DOMAIN_TAGS[phase])
  const viewBytes = bigintToBytes(view)
  const seqBytes = bigintToBytes(sequence)

  const payload = new Uint8Array(tag.length + 1 + viewBytes.length + seqBytes.length + digest.length)
  let pos = 0
  payload.set(tag, pos); pos += tag.length
  payload[pos++] = 0x00
  payload.set(viewBytes, pos); pos += viewBytes.length
  payload.set(seqBytes, pos); pos += seqBytes.length
  payload.set(digest, pos)

  return hash(payload)
}
