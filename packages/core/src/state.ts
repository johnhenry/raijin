/**
 * In-memory state store implementation.
 * Implements StateStore interface with snapshot/revert support.
 */

import type { StateStore, StateSnapshot } from './types.js'
import { hash, merkleRoot, fromHex } from './hash.js'
import { encodeStateEntry } from './encoding.js'

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

  /**
   * Merkle root over every key→value pair, in key order.
   *
   * This used to be `H(key0 || value0 || key1 || value1 || ...)` with no
   * length prefix on anything, so the root did not commit to where one field
   * ended and the next began: a store holding key `0xab` with value `"cd"`
   * and a store holding key `0xabcd` with an empty value flattened to the
   * same bytes and produced the same root. A state root that two different
   * states can share proves nothing about the state — and it is the value a
   * block header carries.
   *
   * Each entry is now hashed through `encodeStateEntry` (domain-tagged,
   * both fields length-prefixed) and the entry hashes are combined with
   * `merkleRoot`, which is itself collision-resistant across leaf lists.
   *
   * Ordering is by the key's bytes, not `localeCompare`: locale-sensitive
   * comparison is a property of the runtime, and two nodes that disagree
   * about it would order the same state differently and derive different
   * roots from identical data.
   */
  async root(): Promise<Uint8Array> {
    const entries = [...this.#data.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

    const leaves = await Promise.all(
      entries.map(([key, value]) => hash(encodeStateEntry(fromHex(key), value))),
    )

    return merkleRoot(leaves)
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

  /** Number of retained snapshots (for tests — asserting no unbounded growth). */
  get snapshotCount(): number {
    return this.#snapshots.size
  }

  /**
   * Export a deep copy of the raw key→value data. Intended for state
   * sync/seeding — e.g. a rejoining/restarted node copying a live peer's
   * state before it starts participating in consensus again, so it doesn't
   * silently diverge (see `importData`).
   */
  exportData(): Map<string, Uint8Array> {
    return new Map(this.#data)
  }

  /** Replace this store's contents with previously-exported data (see `exportData`). */
  importData(data: Map<string, Uint8Array>): void {
    this.#data = new Map(data)
  }
}
