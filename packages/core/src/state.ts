/**
 * In-memory state store implementation.
 * Implements StateStore interface with snapshot/revert support.
 */

import type { StateStore, StateSnapshot } from './types.js'
import { hash, equal } from './hash.js'

/**
 * In-memory state store backed by a sorted Map.
 * Suitable for testing and small state sizes.
 * For production, replace with an IndexedDB or OPFS-backed implementation.
 */
export class InMemoryStateStore implements StateStore {
  #data = new Map<string, Uint8Array>()
  #snapshots = new Map<number, Map<string, Uint8Array>>()
  #nextSnapshotId = 0

  private keyToString(key: Uint8Array): string {
    return Array.from(key)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  }

  async get(key: Uint8Array): Promise<Uint8Array | null> {
    return this.#data.get(this.keyToString(key)) ?? null
  }

  async put(key: Uint8Array, value: Uint8Array): Promise<void> {
    this.#data.set(this.keyToString(key), value)
  }

  async delete(key: Uint8Array): Promise<void> {
    this.#data.delete(this.keyToString(key))
  }

  async root(): Promise<Uint8Array> {
    // Sort keys for determinism, then hash all key-value pairs
    const entries = [...this.#data.entries()].sort(([a], [b]) => a.localeCompare(b))

    if (entries.length === 0) {
      return hash(new Uint8Array(0))
    }

    // Concatenate all key-value pairs and hash
    const parts: Uint8Array[] = []
    for (const [key, value] of entries) {
      const keyBytes = new TextEncoder().encode(key)
      parts.push(keyBytes, value)
    }

    const totalLen = parts.reduce((sum, p) => sum + p.length, 0)
    const combined = new Uint8Array(totalLen)
    let pos = 0
    for (const part of parts) {
      combined.set(part, pos)
      pos += part.length
    }

    return hash(combined)
  }

  async snapshot(): Promise<StateSnapshot> {
    const id = this.#nextSnapshotId++
    this.#snapshots.set(id, new Map(this.#data))
    return { id }
  }

  async revert(snapshot: StateSnapshot): Promise<void> {
    const saved = this.#snapshots.get(snapshot.id)
    if (!saved) throw new Error(`Snapshot ${snapshot.id} not found`)
    this.#data = new Map(saved)
    // Clean up snapshots after this one
    for (const [id] of this.#snapshots) {
      if (id >= snapshot.id) this.#snapshots.delete(id)
    }
  }

  /** Number of keys in the store. */
  get size(): number {
    return this.#data.size
  }
}
