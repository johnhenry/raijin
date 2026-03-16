/**
 * RaijinClient — developer-facing API for interacting with a Raijin network.
 * Submit transactions, query accounts, get blocks, and subscribe to events.
 */

import type {
  Transaction,
  Block,
  Account,
  TransactionReceipt,
} from 'raijin-core'

// ── Transport interface ──────────────────────────────────────────────

/** Transport abstraction for communicating with validators. */
export interface ClientTransport {
  /** Send a transaction and wait for a receipt. */
  submitTransaction(tx: Transaction): Promise<TransactionReceipt>
  /** Query an account by address. */
  getAccount(address: Uint8Array): Promise<Account>
  /** Get a block by height. */
  getBlock(number: bigint): Promise<Block | null>
  /** Subscribe to new block events. Returns an unsubscribe function. */
  onBlock(handler: (block: Block) => void): () => void
}

// ── Client ───────────────────────────────────────────────────────────

export class RaijinClient {
  #transport: ClientTransport

  constructor(transport: ClientTransport) {
    this.#transport = transport
  }

  /** Submit a transaction and wait for its receipt. */
  async submitTransaction(tx: Transaction): Promise<TransactionReceipt> {
    return this.#transport.submitTransaction(tx)
  }

  /** Query an account by address (public key). */
  async getAccount(address: Uint8Array): Promise<Account> {
    return this.#transport.getAccount(address)
  }

  /** Get a block by height. Returns null if not found. */
  async getBlock(number: bigint): Promise<Block | null> {
    return this.#transport.getBlock(number)
  }

  /** Subscribe to new finalized blocks. Returns an unsubscribe function. */
  subscribe(handler: (block: Block) => void): () => void {
    return this.#transport.onBlock(handler)
  }
}
