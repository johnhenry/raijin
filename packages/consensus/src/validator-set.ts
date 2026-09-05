/**
 * Validator set management with deterministic leader rotation.
 */

import { toHex, hash, encodeBytes } from '@johnhenry/raijin-core'

/**
 * Domain tag for the epoch digest, so a validator-set identifier cannot
 * collide with any other hash in the protocol.
 */
const EPOCH_TAG = new TextEncoder().encode('raijin/pbft/v2/validator-set')

export class ValidatorSet {
  #validators: Uint8Array[]
  #indexMap: Map<string, number>
  /** Memoized `epoch()`; dropped whenever the membership changes. */
  #epoch: Uint8Array | null = null

  constructor(validators: Uint8Array[] = []) {
    this.#validators = [...validators]
    this.#indexMap = new Map()
    this.#rebuildIndex()
  }

  #rebuildIndex() {
    this.#indexMap.clear()
    for (let i = 0; i < this.#validators.length; i++) {
      this.#indexMap.set(toHex(this.#validators[i]), i)
    }
    this.#epoch = null
  }

  /** Add a validator. Returns false if already present. */
  add(pubkey: Uint8Array): boolean {
    const key = toHex(pubkey)
    if (this.#indexMap.has(key)) return false
    this.#indexMap.set(key, this.#validators.length)
    this.#validators.push(pubkey)
    this.#epoch = null
    return true
  }

  /** Remove a validator. Returns false if not found. */
  remove(pubkey: Uint8Array): boolean {
    const key = toHex(pubkey)
    const idx = this.#indexMap.get(key)
    if (idx === undefined) return false
    this.#validators.splice(idx, 1)
    this.#rebuildIndex()
    return true
  }

  /**
   * The epoch: a 32-byte identifier for *this exact set, in this exact
   * order*. Every vote signature covers it (see `voteDigest`).
   *
   * It is a digest of the membership rather than a counter, and that is the
   * point. A counter only says how many times a set changed, so two nodes
   * that applied *different* changes still agree on "epoch 2" and go on
   * counting each other's votes. A digest makes the epoch the identity of the
   * set: disagree about who is in it, and you disagree about the epoch, and
   * votes stop crossing between the two. In particular a validator that has
   * been removed cannot have its old, still-valid signatures counted toward
   * the quorum of the set that removed it.
   *
   * Order is included because order is consensus-relevant here —
   * `leaderForView` picks by index, so the same members in a different order
   * elect different leaders and are genuinely a different set.
   *
   * Memoized; recomputed after `add()` or `remove()`.
   */
  async epoch(): Promise<Uint8Array> {
    if (this.#epoch) return this.#epoch

    // Length-prefix each key so that concatenation cannot lose the boundary
    // between two of them — without it, sets with differently-sized keys
    // could flatten to the same bytes.
    const parts: Uint8Array[] = [EPOCH_TAG]
    for (const validator of this.#validators) {
      parts.push(encodeBytes(validator))
    }

    const total = parts.reduce((sum, p) => sum + p.length, 0)
    const payload = new Uint8Array(total)
    let pos = 0
    for (const part of parts) {
      payload.set(part, pos)
      pos += part.length
    }

    this.#epoch = await hash(payload)
    return this.#epoch
  }

  /** Check if a public key is in the validator set. */
  has(pubkey: Uint8Array): boolean {
    return this.#indexMap.has(toHex(pubkey))
  }

  /** Deterministic leader for a given view. Round-robin by index. */
  leaderForView(view: bigint): Uint8Array {
    if (this.#validators.length === 0) {
      throw new Error('Empty validator set')
    }
    const idx = Number(view % BigInt(this.#validators.length))
    return this.#validators[idx]
  }

  /**
   * Quorum size: `n - f`, where `f = floor((n - 1) / 3)`.
   *
   * At the canonical PBFT sizes (`n = 3f + 1`: 1, 4, 7, 10, ...) this is
   * exactly `2f + 1`. For every other `n` it is strictly larger, because
   * `2f + 1` is only safe when `n = 3f + 1`.
   *
   * Safety needs any two quorums to share at least one honest node --
   * `2q - n >= f + 1`. With `q = 2f + 1` that fails for every `n` that is not
   * `3f + 1`, and at `n = 2` or `n = 3` it degenerates to `q = 1`: a single
   * node reaching its own PREPARE and COMMIT quorum, finalizing blocks alone.
   * With `q = n - f` it holds for all `n`.
   *
   *   n:  1  2  3  4  5  6  7  8  9 10
   *   f:  0  0  0  1  1  1  2  2  2  3
   *   q:  1  2  3  3  4  5  5  6  7  7
   */
  quorumSize(): number {
    const n = this.#validators.length
    if (n === 0) return 0
    return n - this.maxFaults
  }

  /** Number of validators. */
  get size(): number {
    return this.#validators.length
  }

  /** Maximum Byzantine faults tolerated: floor((n-1)/3). */
  get maxFaults(): number {
    return Math.floor((this.#validators.length - 1) / 3)
  }

  /** Get all validators. */
  all(): Uint8Array[] {
    return [...this.#validators]
  }

  /** Get validator at index. */
  at(index: number): Uint8Array | undefined {
    return this.#validators[index]
  }
}
