import { describe, it, expect } from 'vitest'
import {
  PersistentStateStore,
  MemoryKVBackend,
  IndexedDbKVBackend,
  InMemoryStateStore,
  checkStateStoreConformance,
  toHex,
  equal,
  type KVBackend,
} from '../src/index.js'

const k = (...b: number[]) => new Uint8Array(b)

// ── Minimal in-memory IndexedDB double: only what IndexedDbKVBackend uses ──
class FakeRequest<T> {
  result!: T
  error: Error | null = null
  onsuccess: (() => void) | null = null
  onerror: (() => void) | null = null
  onupgradeneeded: (() => void) | null = null
}
function fakeIndexedDB() {
  const dbs = new Map<string, Map<string, Map<string, Uint8Array>>>() // db -> store -> data
  const factory = {
    open(name: string) {
      const req = new FakeRequest<unknown>()
      queueMicrotask(() => {
        const isNew = !dbs.has(name)
        if (isNew) dbs.set(name, new Map())
        const stores = dbs.get(name)!
        const db = {
          objectStoreNames: { contains: (n: string) => stores.has(n) },
          createObjectStore: (n: string) => { stores.set(n, new Map()) },
          close() {},
          transaction(storeName: string) {
            const data = stores.get(storeName)!
            const tx: Record<string, unknown> = { oncomplete: null, onerror: null, onabort: null }
            const staged = new Map(data)
            const store = {
              put: (v: Uint8Array, key: string) => { staged.set(key, new Uint8Array(v)) },
              delete: (key: string) => { staged.delete(key) },
              getAllKeys: () => {
                const r = new FakeRequest<string[]>()
                r.result = [...data.keys()].sort()
                return r
              },
              getAll: () => {
                const r = new FakeRequest<Uint8Array[]>()
                r.result = [...data.keys()].sort().map((key) => data.get(key)!)
                return r
              },
            }
            tx.objectStore = () => store
            queueMicrotask(() => queueMicrotask(() => {
              data.clear()
              for (const [key, v] of staged) data.set(key, v)
              ;(tx.oncomplete as (() => void) | null)?.()
            }))
            return tx
          },
        }
        req.result = db
        // createObjectStore needs the "upgrade" phase result to be visible
        ;(req as unknown as { result: unknown }).result = db
        if (isNew) req.onupgradeneeded?.()
        req.onsuccess?.()
      })
      return req
    },
  }
  return factory as unknown as IDBFactory
}

describe('PersistentStateStore', () => {
  it('conforms: root-equivalent to InMemoryStateStore, snapshot/revert, reopen (MemoryKVBackend)', async () => {
    const disks: MemoryKVBackend[] = []
    await checkStateStoreConformance({
      create: async () => {
        const b = new MemoryKVBackend()
        disks.push(b)
        return PersistentStateStore.open(b)
      },
      reopen: (store) => PersistentStateStore.open(disks[0]),
    })
  })

  it('conforms over IndexedDbKVBackend (fake IDB), including reopen', async () => {
    const idb = fakeIndexedDB()
    let n = 0
    await checkStateStoreConformance({
      create: async () => PersistentStateStore.open(new IndexedDbKVBackend({ name: `db${n++}`, indexedDB: idb })),
      reopen: () => PersistentStateStore.open(new IndexedDbKVBackend({ name: 'db0', indexedDB: idb })),
    })
  })

  it('a store reopened over the same backend has the same root and data', async () => {
    const disk = new MemoryKVBackend()
    const a = await PersistentStateStore.open(disk)
    await a.put(k(1), k(10))
    await a.put(k(2), k(20))
    await a.delete(k(1))
    const root = await a.root()
    const b = await PersistentStateStore.open(disk)
    expect(equal(await b.root(), root)).toBe(true)
    expect(await b.get(k(1))).toBeNull()
    expect(equal((await b.get(k(2)))!, k(20))).toBe(true)
  })

  it('does not alias caller buffers', async () => {
    const disk = new MemoryKVBackend()
    const s = await PersistentStateStore.open(disk)
    const v = k(1, 2, 3)
    await s.put(k(1), v)
    v.fill(0)
    expect([...(await s.get(k(1)))!]).toEqual([1, 2, 3])
  })

  it('a failed backend write rejects the put and leaves memory unchanged', async () => {
    const disk = new MemoryKVBackend()
    const s = await PersistentStateStore.open(disk)
    await s.put(k(1), k(1))
    disk.failNextWrite = new Error('disk full')
    await expect(s.put(k(2), k(2))).rejects.toThrow('disk full')
    expect(await s.get(k(2))).toBeNull()
    await s.put(k(2), k(2)) // recovers
    expect((await PersistentStateStore.open(disk)).size).toBe(2)
  })

  it('a failed revert write restores memory to match disk', async () => {
    const disk = new MemoryKVBackend()
    const s = await PersistentStateStore.open(disk)
    const snap = await s.snapshot()
    await s.put(k(1), k(1))
    disk.failNextWrite = new Error('boom')
    await expect(s.revert(snap)).rejects.toThrow('boom')
    expect(await s.get(k(1))).not.toBeNull()
    expect((await PersistentStateStore.open(disk)).size).toBe(1)
  })

  it('importData persists (after flush), is sync-visible, and a failed write surfaces on flush', async () => {
    const disk = new MemoryKVBackend()
    const s = await PersistentStateStore.open(disk)
    await s.put(k(9), k(9))
    const src = new InMemoryStateStore()
    await src.put(k(1), k(1))
    await src.put(k(2), k(2))
    s.importData(src.exportData())
    expect(s.size).toBe(2)
    await s.flush()
    const re = await PersistentStateStore.open(disk)
    expect(equal(await re.root(), await src.root())).toBe(true)
    expect(await re.get(k(9))).toBeNull()

    disk.failNextWrite = new Error('io')
    s.importData(new Map())
    await expect(s.flush()).rejects.toThrow('io')
  })

  it('serialises concurrent writes so disk matches memory', async () => {
    const disk = new MemoryKVBackend()
    const s = await PersistentStateStore.open(disk)
    await Promise.all(Array.from({ length: 50 }, (_, i) => s.put(k(i % 5), k(i))))
    const re = await PersistentStateStore.open(disk)
    expect(toHex(await re.root())).toBe(toHex(await s.root()))
  })

  it('opens an empty backend as an empty store', async () => {
    const s = await PersistentStateStore.open(new MemoryKVBackend() as KVBackend)
    expect(equal(await s.root(), await new InMemoryStateStore().root())).toBe(true)
  })
})

describe('checkStateStoreConformance', () => {
  it('passes for InMemoryStateStore itself', async () => {
    await checkStateStoreConformance({ create: () => new InMemoryStateStore() })
  })

  it('fails a store whose root ignores a value', async () => {
    class Broken extends InMemoryStateStore {
      override async put(key: Uint8Array, _value: Uint8Array) { await super.put(key, new Uint8Array(0)) }
    }
    await expect(checkStateStoreConformance({ create: () => new Broken() })).rejects.toThrow(/conformance/)
  })
})
