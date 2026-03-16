/**
 * Core types for the Raijin mesh rollup.
 * Zero external dependencies. Uses only globalThis.crypto.
 */

// ── Transactions ──────────────────────────────────────────────────────

export interface Transaction {
  /** Sender's public key (32 bytes) */
  from: Uint8Array
  /** Monotonically increasing per-sender counter */
  nonce: bigint
  /** Recipient public key, or null for system operations */
  to: Uint8Array | null
  /** Amount to transfer (in smallest unit) */
  value: bigint
  /** Arbitrary payload (transaction-type-specific) */
  data: Uint8Array
  /** Signature over the transaction hash */
  signature: Uint8Array
  /** Chain identifier to prevent cross-chain replay */
  chainId: bigint
}

export enum TransactionType {
  Transfer = 0x01,
  ReputationAttest = 0x02,
  CredentialMint = 0x03,
  CredentialRevoke = 0x04,
  GovernancePropose = 0x05,
  GovernanceVote = 0x06,
  ServiceList = 0x07,
  ServiceDelist = 0x08,
  AuditAnchor = 0x09,
  IdentityRegister = 0x0a,
  IdentityUpdate = 0x0b,
  IdentityRecover = 0x0c,
  EscrowCreate = 0x0d,
  EscrowRelease = 0x0e,
  EscrowRefund = 0x0f,
}

// ── Blocks ────────────────────────────────────────────────────────────

export interface BlockHeader {
  /** Block number (height) */
  number: bigint
  /** Hash of the previous block */
  parentHash: Uint8Array
  /** Merkle root of the state trie after this block */
  stateRoot: Uint8Array
  /** Merkle root of the transactions in this block */
  txRoot: Uint8Array
  /** Merkle root of the transaction receipts */
  receiptRoot: Uint8Array
  /** Block timestamp (unix ms) */
  timestamp: number
  /** Public key of the block proposer */
  proposer: Uint8Array
}

export interface Block {
  header: BlockHeader
  transactions: Transaction[]
  /** Aggregated signatures from validators (2/3+) */
  signatures: Uint8Array[]
}

// ── Accounts ──────────────────────────────────────────────────────────

export interface Account {
  /** Current balance */
  balance: bigint
  /** Next expected nonce */
  nonce: bigint
  /** Reputation score */
  reputation: bigint
}

// ── Receipts ──────────────────────────────────────────────────────────

export interface TransactionReceipt {
  /** Hash of the transaction */
  txHash: Uint8Array
  /** Execution status */
  status: 'success' | 'revert'
  /** Reason for revert (if applicable) */
  revertReason?: string
  /** Index within the block */
  index: number
}

// ── Interfaces (inject your implementation) ───────────────────────────

export interface StateStore {
  /** Get a value by key */
  get(key: Uint8Array): Promise<Uint8Array | null>
  /** Set a value */
  put(key: Uint8Array, value: Uint8Array): Promise<void>
  /** Delete a key */
  delete(key: Uint8Array): Promise<void>
  /** Compute the Merkle root of the current state */
  root(): Promise<Uint8Array>
  /** Create a snapshot for rollback */
  snapshot(): Promise<StateSnapshot>
  /** Revert to a previous snapshot */
  revert(snapshot: StateSnapshot): Promise<void>
}

export interface StateSnapshot {
  id: number
}

export interface SignatureVerifier {
  /** Verify a signature against a message and public key */
  verify(
    message: Uint8Array,
    signature: Uint8Array,
    publicKey: Uint8Array,
  ): Promise<boolean>
}

export interface TransactionSigner {
  /** The signer's public key */
  readonly publicKey: Uint8Array
  /** Sign a message */
  sign(message: Uint8Array): Promise<Uint8Array>
}
