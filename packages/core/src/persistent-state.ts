/**
 * Durable state: a `StateStore` that writes through to a pluggable key-value
 * backend, so a validator's chain survives a restart.
 *
 * `PersistentStateStore` keeps the working set in an `InMemoryStateStore`
 * (reads, `root()`, `snapshot()`/`revert()` are exactly the in-memory ones, so
 * roots are byte-for-byte equivalent by construction) and mirrors every
 * mutation to a `KVBackend`. A backend is small and dumb on purpose: load
 * everything, apply an atomic batch. Ship one per storage medium --
 * `IndexedDbKVBackend` (browser) and `MemoryKVBackend` (tests, or a stand-in
 * for "the disk that outlives the process") are provided.
 */

import type { StateStore, StateSnapshot } from './types.js'
import { InMemoryStateStore } from './state.js'
import { toHex } from './hash.js'

/** One atomic mutation of a backend. Keys are lowercase hex strings. */
export interface KVBatch {
  puts: Array<[key: string, value: Uint8Array]>
  deletes: string[]
}

/**
 * A durable key->value medium. `write` MUST be atomic: after a crash either
 * the whole batch is visible or none of it is.
 */
export interface KVBackend {
  /** Every stored entry (key = lowercase hex of the state key). */
  loadAll(): Promise<Map<string, Uint8Array>>
  /** Atomically apply a batch. Resolves once it is durable. */
  write(batch: KVBatch): Promise<void>
  /** Release handles. Optional. */
  close?(): void | Promise<void>
}

/** In-process backend. Hand the same instance to a second store to simulate a restart. */
export class MemoryKVBackend implements KVBackend {
  #data = new Map<string, Uint8Array>()
  /** Test hook: when set, the next `write` rejects with it (and changes nothing). */
  failNextWrite: Error | null = null
  writes = 0

  async loadAll(): Promise<Map<string, Uint8Array>> {
    return new Map([...this.#data].map(([k, v]) => [k, v.slice()]))
  }

  async write(batch: KVBatch): Promise<void> {
    if (this.failNextWrite) {
      const e = this.failNextWrite
      this.failNextWrite = null
      throw e
    }
    this.writes++
    for (const [k, v] of batch.puts) this.#data.set(k, v.slice())
    for (const k of batch.deletes) this.#data.delete(k)
  }
}

export interface IndexedDbKVBackendOptions {
  /** Database name. Use a different one per chain/validator. */
  name: string
  /** Object store name. Default `'kv'`. */
  storeName?: string
  /** Override the factory (default `globalThis.indexedDB`). */
  indexedDB?: IDBFactory
}

/**
 * Browser backend over IndexedDB. One object store of hex-key -> `Uint8Array`;
 * every `write` is a single readwrite transaction, so it is atomic.
 */
export class IndexedDbKVBackend implements KVBackend {
  #name: string
  #storeName: string
  #factory: IDBFactory | undefined
  #db: Promise<IDBDatabase> | null = null

  constructor(opts: IndexedDbKVBackendOptions) {
    this.#name = opts.name
    this.#storeName = opts.storeName ?? 'kv'
    this.#factory = opts.indexedDB
  }

  #open(): Promise<IDBDatabase> {
    if (this.#db) return this.#db
    const factory = this.#factory ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB
    if (!factory) return Promise.reject(new Error('IndexedDbKVBackend: no indexedDB available'))
    this.#db = new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(this.#name, 1)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(this.#storeName)) {
          req.result.createObjectStore(this.#storeName)
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('IndexedDbKVBackend: open failed'))
    })
    this.#db.catch(() => { this.#db = null })
    return this.#db
  }

  async loadAll(): Promise<Map<string, Uint8Array>> {
    const db = await this.#open()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.#storeName, 'readonly')
      const store = tx.objectStore(this.#storeName)
      const keysReq = store.getAllKeys()
      const valsReq = store.getAll()
      tx.oncomplete = () => {
        const out = new Map<string, Uint8Array>()
        const keys = keysReq.result as string[]
        const vals = valsReq.result as Uint8Array[]
        keys.forEach((k, i) => out.set(String(k), new Uint8Array(vals[i])))
        resolve(out)
      }
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDbKVBackend: read failed'))
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDbKVBackend: read aborted'))
    })
  }

  async write(batch: KVBatch): Promise<void> {
    if (batch.puts.length === 0 && batch.deletes.length === 0) return
    const db = await this.#open()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.#storeName, 'readwrite')
      const store = tx.objectStore(this.#storeName)
      for (const [k, v] of batch.puts) store.put(v, k)
      for (const k of batch.deletes) store.delete(k)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDbKVBackend: write failed'))
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDbKVBackend: write aborted'))
    })
  }

  async close(): Promise<void> {
    if (!this.#db) return
    const db = await this.#db
    db.close()
    this.#db = null
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** Minimal batch turning `before` into `after`. */
function diff(before: Map<string, Uint8Array>, after: Map<string, Uint8Array>): KVBatch {
  const puts: KVBatch['puts'] = []
  const deletes: string[] = []
  for (const [k, v] of after) {
    const old = before.get(k)
    if (!old || !sameBytes(old, v)) puts.push([k, v])
  }
  for (const k of before.keys()) if (!after.has(k)) deletes.push(k)
  return { puts, deletes }
}

/**
 * A `StateStore` + `SyncableStateStore` whose contents survive a restart.
 *
 * Construct with `await PersistentStateStore.open(backend)`, which loads
 * whatever the backend holds. `put`/`delete`/`revert` resolve only after the
 * change is durable, and a backend failure rejects the call and leaves the
 * in-memory state untouched, so memory never gets ahead of disk.
 *
 * `importData` is synchronous (the `SyncableStateStore` contract), so its disk
 * write happens in the background; `flush()` awaits it and rethrows any
 * failure, and the next `put`/`delete`/`flush` rethrows a failed background
 * write too. `ValidatorNode.importSyncState` awaits `flush()` when present.
 *
 * Snapshots are in-memory only (they exist to roll back within a block, not
 * across restarts).
 */
export class PersistentStateStore implements StateStore {
  #mem = new InMemoryStateStore()
  #backend: KVBackend
  #tail: Promise<void> = Promise.resolve()
  #bgError: unknown = null

  private constructor(backend: KVBackend) {
    this.#backend = backend
  }

  /** Load the backend's contents and return a store over them. */
  static async open(backend: KVBackend): Promise<PersistentStateStore> {
    const store = new PersistentStateStore(backend)
    store.#mem.importData(await backend.loadAll())
    return store
  }

  #enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.#tail.then(fn)
    this.#tail = p.then(() => undefined, () => undefined)
    return p
  }

  #throwBg(): void {
    if (this.#bgError !== null) {
      const e = this.#bgError
      this.#bgError = null
      throw e
    }
  }

  get(key: Uint8Array): Promise<Uint8Array | null> {
    return this.#mem.get(key)
  }

  async put(key: Uint8Array, value: Uint8Array): Promise<void> {
    this.#throwBg()
    const k = toHex(key)
    const v = value.slice()
    await this.#enqueue(async () => {
      await this.#backend.write({ puts: [[k, v]], deletes: [] })
      await this.#mem.put(key, v)
    })
  }

  async delete(key: Uint8Array): Promise<void> {
    this.#throwBg()
    const k = toHex(key)
    await this.#enqueue(async () => {
      if ((await this.#mem.get(key)) === null) return
      await this.#backend.write({ puts: [], deletes: [k] })
      await this.#mem.delete(key)
    })
  }

  root(): Promise<Uint8Array> {
    return this.#mem.root()
  }

  snapshot(): Promise<StateSnapshot> {
    return this.#mem.snapshot()
  }

  async revert(snapshot: StateSnapshot): Promise<void> {
    await this.#enqueue(async () => {
      const before = this.#mem.exportData()
      await this.#mem.revert(snapshot)
      const batch = diff(before, this.#mem.exportData())
      try {
        await this.#backend.write(batch)
      } catch (e) {
        this.#mem.importData(before) // keep memory == disk
        throw e
      }
    })
  }

  /** Number of keys. */
  get size(): number {
    return this.#mem.size
  }

  /** Deep copy of the key (hex) -> value data (see `SyncableStateStore`). */
  exportData(): Map<string, Uint8Array> {
    return this.#mem.exportData()
  }

  /**
   * Replace the contents. Memory updates immediately; the disk write is
   * queued. Await `flush()` for durability.
   */
  importData(data: Map<string, Uint8Array>): void {
    const before = this.#mem.exportData()
    this.#mem.importData(data)
    const batch = diff(before, this.#mem.exportData())
    this.#enqueue(() => this.#backend.write(batch)).catch((e) => {
      this.#bgError ??= e
    })
  }

  /** Resolves when every queued write is durable; rethrows a failed background write. */
  async flush(): Promise<void> {
    await this.#tail
    this.#throwBg()
  }

  /** Flush, then release the backend. */
  async close(): Promise<void> {
    await this.flush()
    await this.#backend.close?.()
  }
}
