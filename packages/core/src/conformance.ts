/**
 * `StateStore` conformance check. Run it against any implementation (a Node
 * file store, an OPFS store, ...) to prove it is root-equivalent to
 * `InMemoryStateStore` and honours snapshot/revert -- the two properties
 * consensus depends on. Framework-agnostic: it throws on the first violation,
 * so call it from inside any test runner (`await checkStateStoreConformance(...)`).
 */

import type { StateStore, Transaction } from './types.js'
import { encodeTx } from './encoding.js'
import { InMemoryStateStore } from './state.js'
import { StateMachine, accountKey } from './state-machine.js'
import { encodeAccount } from './encoding.js'
import { ed25519Verifier, signEd25519 } from './crypto.js'
import { equal, toHex } from './hash.js'

export interface StateStoreConformanceOptions {
  /** Create a fresh, EMPTY store. Called several times. */
  create: () => StateStore | Promise<StateStore>
  /** Optional: simulate a restart -- return a new store over what `store` persisted. */
  reopen?: (store: StateStore) => StateStore | Promise<StateStore>
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`StateStore conformance: ${msg}`)
}

async function sameRoot(a: StateStore, b: StateStore, msg: string): Promise<void> {
  assert(equal(await a.root(), await b.root()), `${msg} (root differs from InMemoryStateStore: ${toHex(await a.root())} vs ${toHex(await b.root())})`)
}

const k = (...b: number[]) => new Uint8Array(b)

/** Throws if `create()`'s store deviates from `InMemoryStateStore` semantics. */
export async function checkStateStoreConformance(opts: StateStoreConformanceOptions): Promise<void> {
  const ref = new InMemoryStateStore()
  const store = await opts.create()

  await sameRoot(store, ref, 'empty store')
  assert((await store.get(k(1))) === null, 'get of a missing key must be null')

  // put / get / overwrite / delete, in a deliberately non-sorted insertion order
  for (const [key, val] of [[k(9, 9), k(1)], [k(1), k(2, 3)], [k(1, 0), new Uint8Array(0)], [k(0xff), k(7)]] as const) {
    await store.put(key, val)
    await ref.put(key, val)
  }
  assert(equal((await store.get(k(1)))!, k(2, 3)), 'get after put')
  assert((await store.get(k(1, 0)))!.length === 0, 'empty value must round-trip and differ from missing')
  await sameRoot(store, ref, 'after puts')
  await store.put(k(1), k(4))
  await ref.put(k(1), k(4))
  await sameRoot(store, ref, 'after overwrite')
  await store.delete(k(9, 9))
  await ref.delete(k(9, 9))
  await store.delete(k(5, 5, 5)) // deleting a missing key is a no-op
  await sameRoot(store, ref, 'after delete')

  // snapshot / revert (including nested: reverting to an earlier snapshot drops later ones)
  const s1 = await store.snapshot()
  const r1 = await ref.snapshot()
  await store.put(k(2), k(2))
  await ref.put(k(2), k(2))
  await store.delete(k(1))
  await ref.delete(k(1))
  const s2 = await store.snapshot()
  const r2 = await ref.snapshot()
  await store.put(k(3), k(3))
  await ref.put(k(3), k(3))
  await store.revert(s2)
  await ref.revert(r2)
  await sameRoot(store, ref, 'after reverting to the inner snapshot')
  assert((await store.get(k(3))) === null, 'revert must undo later writes')
  await store.revert(s1)
  await ref.revert(r1)
  await sameRoot(store, ref, 'after reverting to the outer snapshot')
  assert(equal((await store.get(k(1)))!, k(4)), 'revert must restore deleted keys')
  assert((await store.get(k(2))) === null, 'revert must remove keys added after the snapshot')

  // restart equivalence
  if (opts.reopen) {
    const root = await store.root()
    const again = await opts.reopen(store)
    assert(equal(await again.root(), root), 'a reopened store must have the same root as before the restart')
    assert(equal((await again.get(k(0xff)))!, k(7)), 'a reopened store must still hold its data')
    assert((await again.get(k(2))) === null, 'a reverted write must not reappear after reopening')
  }

  // The StateMachine produces identical roots over this store and the reference.
  const pair = (await globalThis.crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair
  const who = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', pair.publicKey))
  const dest = new Uint8Array(32).fill(8)
  const unsigned: Transaction = {
    from: who, nonce: 0n, to: dest, value: 3n,
    data: new Uint8Array(0), signature: new Uint8Array(0), chainId: 1n,
  }
  const tx: Transaction = { ...unsigned, signature: await signEd25519(pair.privateKey, encodeTx(unsigned)) }
  const smStore = await opts.create()
  const smRefStore = new InMemoryStateStore()
  for (const st of [smStore, smRefStore]) {
    await st.put(accountKey(who), encodeAccount({ balance: 10n, nonce: 0n, reputation: 0n }))
    const receipt = await new StateMachine(st, ed25519Verifier).applyTransaction(tx, 0)
    assert(receipt.status === 'success', `sanity: signed transfer applies (${receipt.revertReason ?? ''})`)
  }
  await sameRoot(smStore, smRefStore, 'after a StateMachine transaction')
}
