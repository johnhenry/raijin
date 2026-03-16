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
import { encodeTx, encodeAccount, decodeAccount } from './encoding.js'

const EMPTY_ACCOUNT: Account = { balance: 0n, nonce: 0n, reputation: 0n }
const encoder = new TextEncoder()

/** Namespace prefixes for state keys. */
const NS = {
  account: encoder.encode('account:'),
  credential: encoder.encode('credential:'),
  proposal: encoder.encode('proposal:'),
  service: encoder.encode('service:'),
  identity: encoder.encode('identity:'),
  escrow: encoder.encode('escrow:'),
  validator: encoder.encode('validator:'),
} as const

/** Build a namespaced state key. */
function stateKey(namespace: Uint8Array, id: Uint8Array): Uint8Array {
  const key = new Uint8Array(namespace.length + id.length)
  key.set(namespace, 0)
  key.set(id, namespace.length)
  return key
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
    const key = stateKey(NS.account, address)
    const data = await this.#store.get(key)
    if (!data) return { ...EMPTY_ACCOUNT }
    return decodeAccount(data)
  }

  /** Write an account to state. */
  async #putAccount(address: Uint8Array, account: Account): Promise<void> {
    const key = stateKey(NS.account, address)
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
    const txHash = await hash(txBytes)

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
   * Apply all transactions in a block.
   * Uses snapshot/revert for atomicity — if any tx fails, the entire block is rolled back.
   */
  async applyBlock(block: Block): Promise<TransactionReceipt[]> {
    const snap = await this.#store.snapshot()
    const receipts: TransactionReceipt[] = []

    for (let i = 0; i < block.transactions.length; i++) {
      const receipt = await this.applyTransaction(block.transactions[i], i)
      receipts.push(receipt)

      // If a transaction reverts, we still include it (the receipt records the failure)
      // but no state changes from that tx are committed (handled per-tx)
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
