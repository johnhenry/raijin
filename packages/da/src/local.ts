/**
 * LocalDA — in-memory data availability layer for testing and development.
 *
 * Stores data in a Map keyed by content hash. No network, no persistence.
 * Uses globalThis.crypto.subtle for SHA-256 hashing (works in browser + Node).
 */

import { hash, equal, toHex } from 'raijin-core'
import type { DALayer, DACommitment } from './types.js'

export class LocalDA implements DALayer {
  readonly name = 'local'

  /** In-memory blob store: hex(hash) -> data */
  readonly #store = new Map<string, Uint8Array>()

  /** Monotonically increasing block height for commitments */
  #height = 0n

  /** Index counter within the current "block" */
  #index = 0

  async submit(data: Uint8Array): Promise<DACommitment> {
    const h = await hash(data)
    const key = toHex(h)
    this.#store.set(key, new Uint8Array(data)) // defensive copy

    const commitment: DACommitment = {
      layer: this.name,
      height: this.#height,
      index: this.#index,
      hash: h,
    }

    this.#index++
    return commitment
  }

  async retrieve(commitment: DACommitment): Promise<Uint8Array> {
    const key = toHex(commitment.hash)
    const data = this.#store.get(key)
    if (!data) {
      throw new Error(`LocalDA: no data found for hash ${key}`)
    }
    return new Uint8Array(data) // defensive copy
  }

  async verify(commitment: DACommitment): Promise<boolean> {
    const key = toHex(commitment.hash)
    const data = this.#store.get(key)
    if (!data) return false

    const computed = await hash(data)
    return equal(computed, commitment.hash)
  }

  /** Advance to the next block height. Useful for simulating block boundaries in tests. */
  nextBlock(): void {
    this.#height++
    this.#index = 0
  }

  /** Number of blobs stored. */
  get size(): number {
    return this.#store.size
  }

  /** Clear all stored data. */
  clear(): void {
    this.#store.clear()
    this.#height = 0n
    this.#index = 0
  }
}
