/**
 * The core state transition function.
 * Pure: given state S and transaction T, produces state S'.
 * Zero external dependencies.
 */

import type {
  Transaction,
  Block,
  Account,
  TransactionReceipt,
  StateStore,
  SignatureVerifier,
} from './types.js'
import { TransactionType } from './types.js'
import { hash, merkleRoot } from './hash.js'
import {
  encodeTx,
  encodeTxSigned,
  encodeAccount,
  decodeAccount,
  encodeBytes,
  Domain,
} from './encoding.js'

const EMPTY_ACCOUNT: Account = { balance: 0n, nonce: 0n, reputation: 0n }
const encoder = new TextEncoder()

/**
 * Namespace prefixes for state keys.
 *
 * Exported because a state key's bytes are consensus-critical: every key is
 * hashed into the state root, so anything that writes state directly — genesis
 * funding, a test fixture, a state-sync importer — must produce byte-identical
 * keys or the node silently forks from its peers at the first root comparison.
 * Build keys with `accountKey`/`stateKey`, never by concatenating by hand.
 */
export const StateNamespace = {
  account: encoder.encode('account:'),
  credential: encoder.encode('credential:'),
  proposal: encoder.encode('proposal:'),
  service: encoder.encode('service:'),
  identity: encoder.encode('identity:'),
  escrow: encoder.encode('escrow:'),
  validator: encoder.encode('validator:'),
} as const

/**
 * Build a namespaced state key: `0x07 ‖ len(namespace) ‖ namespace ‖ len(id) ‖ id`.
 *
 * This used to be the bare concatenation `namespace ‖ id`, which was
 * unambiguous only by coincidence. Two coincidences, in fact, and neither is
 * enforced anywhere: that the namespaces defined above happen to be
 * prefix-free (they differ in their first byte — a, c, p, s, i, e, v), and
 * that every id in use happens to be a fixed-width 32-byte public key.
 * Neither the `Uint8Array` type nor any runtime check holds either property.
 * Add a namespace whose name extends another's, or a variable-length id, and
 * `ns₁ ‖ id₁` can equal `ns₂ ‖ id₂` for different pairs — two different pieces
 * of state at one key, and a state root that no longer says which one it
 * committed to.
 *
 * Length-prefixing removes the coincidence: each field is self-delimiting, so
 * distinct `(namespace, id)` pairs always produce distinct keys. The domain
 * tag keeps a state key from colliding with any other encoded structure. Keys
 * within one namespace still share a common prefix and so still sort and scan
 * together, because a namespace's own length is fixed.
 */
export function stateKey(namespace: Uint8Array, id: Uint8Array): Uint8Array {
  const ns = encodeBytes(namespace)
  const body = encodeBytes(id)
  const key = new Uint8Array(1 + ns.length + body.length)
  key[0] = Domain.StateKey
  key.set(ns, 1)
  key.set(body, 1 + ns.length)
  return key
}

/**
 * The state key an account record lives under.
 *
 * This is the key genesis funding must write to — see the "Genesis funding"
 * section of the package README.
 */
export function accountKey(address: Uint8Array): Uint8Array {
  return stateKey(StateNamespace.account, address)
}

/**
 * The Raijin state machine.
 * Applies transactions to the state store, producing receipts.
 */
export class StateMachine {
  #store: StateStore
  #verifier: SignatureVerifier

  constructor(store: StateStore, verifier: SignatureVerifier) {
    this.#store = store
    this.#verifier = verifier
  }

  /** Get an account from state, returning a zero account if not found. */
  async getAccount(address: Uint8Array): Promise<Account> {
    const key = accountKey(address)
    const data = await this.#store.get(key)
    if (!data) return { ...EMPTY_ACCOUNT }
    return decodeAccount(data)
  }

  /** Write an account to state. */
  async #putAccount(address: Uint8Array, account: Account): Promise<void> {
    const key = accountKey(address)
    await this.#store.put(key, encodeAccount(account))
  }

  /** Compute the current state root. */
  async stateRoot(): Promise<Uint8Array> {
    return this.#store.root()
  }

  /**
   * Apply a single transaction to the state.
   * Returns a receipt indicating success or failure.
   */
  async applyTransaction(tx: Transaction, index: number): Promise<TransactionReceipt> {
    const txBytes = encodeTx(tx)
    // The canonical transaction identifier includes the signature (matches the
    // hash used for block txRoot leaves and mempool dedup keys) — see
    // encodeTxSigned. Signature *verification* below is still over the
    // unsigned body, since that's what was actually signed.
    const txHash = await hash(encodeTxSigned(tx))

    // 1. Verify signature
    const valid = await this.#verifier.verify(txBytes, tx.signature, tx.from)
    if (!valid) {
      return { txHash, status: 'revert', revertReason: 'invalid signature', index }
    }

    // 2. Check nonce
    const sender = await this.getAccount(tx.from)
    if (tx.nonce !== sender.nonce) {
      return { txHash, status: 'revert', revertReason: `nonce mismatch: expected ${sender.nonce}, got ${tx.nonce}`, index }
    }

    // 3. Decode transaction type from first byte of data
    const txType = tx.data.length > 0 ? tx.data[0] : TransactionType.Transfer

    // 4. Execute based on type
    try {
      switch (txType) {
        case TransactionType.Transfer:
          return await this.#executeTransfer(tx, txHash, sender, index)
        case TransactionType.ReputationAttest:
          return await this.#executeReputationAttest(tx, txHash, sender, index)
        default:
          // For now, all other types just increment nonce (placeholder)
          sender.nonce++
          await this.#putAccount(tx.from, sender)
          return { txHash, status: 'success', index }
      }
    } catch (err: any) {
      return { txHash, status: 'revert', revertReason: err.message, index }
    }
  }

  /**
   * Apply all transactions in a block, in order.
   *
   * NOTE on atomicity: this does NOT take a store-wide snapshot/revert around
   * the whole block. Each transaction executor already checks preconditions
   * (signature, nonce, balance/reputation) before mutating any state, so a
   * failing transaction produces a 'revert' receipt without itself mutating
   * state — but this is per-transaction isolation, not block-level atomic
   * rollback. If a later requirement needs "abort the whole block if any tx
   * fails," that must be implemented explicitly (e.g. by snapshotting before
   * the loop and calling `#store.revert()` if any receipt reverts), since
   * `StateStore.snapshot()`/`revert()` are otherwise unused here.
   */
  async applyBlock(block: Block): Promise<TransactionReceipt[]> {
    const receipts: TransactionReceipt[] = []

    for (let i = 0; i < block.transactions.length; i++) {
      const receipt = await this.applyTransaction(block.transactions[i], i)
      receipts.push(receipt)
    }

    return receipts
  }

  // ── Transaction Executors ─────────────────────────────────────────

  async #executeTransfer(
    tx: Transaction,
    txHash: Uint8Array,
    sender: Account,
    index: number,
  ): Promise<TransactionReceipt> {
    if (!tx.to) {
      return { txHash, status: 'revert', revertReason: 'transfer requires recipient', index }
    }

    if (sender.balance < tx.value) {
      return { txHash, status: 'revert', revertReason: 'insufficient balance', index }
    }

    // Debit sender
    sender.balance -= tx.value
    sender.nonce++
    await this.#putAccount(tx.from, sender)

    // Credit recipient
    const recipient = await this.getAccount(tx.to)
    recipient.balance += tx.value
    await this.#putAccount(tx.to, recipient)

    return { txHash, status: 'success', index }
  }

  async #executeReputationAttest(
    tx: Transaction,
    txHash: Uint8Array,
    sender: Account,
    index: number,
  ): Promise<TransactionReceipt> {
    if (!tx.to) {
      return { txHash, status: 'revert', revertReason: 'attestation requires target', index }
    }

    // Attestation costs 1 unit from sender's reputation (you must have reputation to give it)
    if (sender.reputation < 1n) {
      return { txHash, status: 'revert', revertReason: 'insufficient reputation to attest', index }
    }

    sender.reputation -= 1n
    sender.nonce++
    await this.#putAccount(tx.from, sender)

    const target = await this.getAccount(tx.to)
    target.reputation += 1n
    await this.#putAccount(tx.to, target)

    return { txHash, status: 'success', index }
  }
}
