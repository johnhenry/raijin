/**
 * @johnhenry/raijin-core — State machine, blocks, and transactions for the Raijin mesh rollup.
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

// State keys — the canonical layout for anything writing state directly
// (genesis funding, fixtures, state sync). See `stateKey`'s docs.
export { StateNamespace, stateKey, accountKey } from './state-machine.js'

// State store
export { InMemoryStateStore } from './state.js'

// Hashing
export { hash, hashString, merkleRoot, equal, toHex, fromHex } from './hash.js'

// Encoding
export { Domain, type DomainTag } from './encoding.js'
export {
  encodeBigInt,
  decodeBigInt,
  encodeBytes,
  decodeBytes,
  encodeTx,
  encodeTxSigned,
  encodeAccount,
  decodeAccount,
  encodeReceipt,
  encodeStateEntry,
  encodeBlockHeader,
  blockHash,
} from './encoding.js'

// Cryptography
export { verifyEd25519, ed25519Verifier } from './crypto.js'

// Errors
export {
  RaijinError,
  InvalidTransactionError,
  InvalidBlockError,
  StateError,
  InsufficientBalanceError,
} from './errors.js'
