/**
 * raijin-core — State machine, blocks, and transactions for the Raijin mesh rollup.
 *
 * Zero external dependencies. Uses only globalThis.crypto.subtle.
 * Works in browser and Node.js.
 */

// Types
export type {
  Transaction,
  Block,
  BlockHeader,
  Account,
  TransactionReceipt,
  StateStore,
  StateSnapshot,
  SignatureVerifier,
  TransactionSigner,
} from './types.js'

export { TransactionType } from './types.js'

// State machine
export { StateMachine } from './state-machine.js'

// State store
export { InMemoryStateStore } from './state.js'

// Hashing
export { hash, hashString, merkleRoot, equal, toHex, fromHex } from './hash.js'

// Encoding
export {
  encodeBigInt,
  decodeBigInt,
  encodeBytes,
  decodeBytes,
  encodeTx,
  encodeTxSigned,
  encodeAccount,
  decodeAccount,
} from './encoding.js'

// Errors
export {
  RaijinError,
  InvalidTransactionError,
  InvalidBlockError,
  StateError,
  InsufficientBalanceError,
} from './errors.js'
