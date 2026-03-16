/**
 * Validator set management with deterministic leader rotation.
 */

import { toHex } from 'raijin-core'

export class ValidatorSet {
  #validators: Uint8Array[]
  #indexMap: Map<string, number>

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
  }

  /** Add a validator. Returns false if already present. */
  add(pubkey: Uint8Array): boolean {
    const key = toHex(pubkey)
    if (this.#indexMap.has(key)) return false
    this.#indexMap.set(key, this.#validators.length)
    this.#validators.push(pubkey)
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

  /** Quorum size: 2f + 1 where n = 3f + 1. */
  quorumSize(): number {
    const n = this.#validators.length
    if (n === 0) return 0
    // f = floor((n - 1) / 3)
    const f = Math.floor((n - 1) / 3)
    return 2 * f + 1
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
