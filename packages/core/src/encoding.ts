/**
 * Canonical binary encoding for transactions and blocks.
 * Deterministic — same input always produces same bytes.
 * Zero dependencies.
 */

import type { Transaction, Block, BlockHeader, Account, TransactionReceipt } from './types.js'
import { hash } from './hash.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

// ── Primitive encoders ────────────────────────────────────────────────

/** Encode a bigint as a variable-length unsigned integer (LEB128). */
export function encodeBigInt(value: bigint): Uint8Array {
  if (value === 0n) return new Uint8Array([0])
  const bytes: number[] = []
  let v = value
  while (v > 0n) {
    let byte = Number(v & 0x7fn)
    v >>= 7n
    if (v > 0n) byte |= 0x80
    bytes.push(byte)
  }
  return new Uint8Array(bytes)
}

/** Decode a LEB128 bigint. Returns [value, bytesConsumed]. */
export function decodeBigInt(data: Uint8Array, offset = 0): [bigint, number] {
  let value = 0n
  let shift = 0n
  let pos = offset
  while (pos < data.length) {
    const byte = data[pos]
    value |= BigInt(byte & 0x7f) << shift
    pos++
    if ((byte & 0x80) === 0) break
    shift += 7n
  }
  return [value, pos - offset]
}

/** Encode a length-prefixed byte array. */
export function encodeBytes(data: Uint8Array): Uint8Array {
  const len = encodeBigInt(BigInt(data.length))
  const result = new Uint8Array(len.length + data.length)
  result.set(len, 0)
  result.set(data, len.length)
  return result
}

/** Decode a length-prefixed byte array. Returns [data, bytesConsumed]. */
export function decodeBytes(data: Uint8Array, offset = 0): [Uint8Array, number] {
  const [len, lenSize] = decodeBigInt(data, offset)
  const start = offset + lenSize
  const end = start + Number(len)
  return [data.slice(start, end), lenSize + Number(len)]
}

// ── Transaction encoding ──────────────────────────────────────────────

/** Encode a transaction into deterministic bytes (for hashing/signing). */
export function encodeTx(tx: Transaction): Uint8Array {
  const parts: Uint8Array[] = [
    encodeBytes(tx.from),
    encodeBigInt(tx.nonce),
    encodeBytes(tx.to ?? new Uint8Array(0)),
    encodeBigInt(tx.value),
    encodeBytes(tx.data),
    encodeBigInt(tx.chainId),
  ]
  // Concatenate
  const totalLen = parts.reduce((sum, p) => sum + p.length, 0)
  const result = new Uint8Array(totalLen)
  let pos = 0
  for (const part of parts) {
    result.set(part, pos)
    pos += part.length
  }
  return result
}

/** Encode a transaction including its signature. */
export function encodeTxSigned(tx: Transaction): Uint8Array {
  const body = encodeTx(tx)
  const sig = encodeBytes(tx.signature)
  const result = new Uint8Array(body.length + sig.length)
  result.set(body, 0)
  result.set(sig, body.length)
  return result
}

// ── Account encoding ──────────────────────────────────────────────────

/** Encode an account to bytes. */
export function encodeAccount(account: Account): Uint8Array {
  const parts = [
    encodeBigInt(account.balance),
    encodeBigInt(account.nonce),
    encodeBigInt(account.reputation),
  ]
  const totalLen = parts.reduce((sum, p) => sum + p.length, 0)
  const result = new Uint8Array(totalLen)
  let pos = 0
  for (const part of parts) {
    result.set(part, pos)
    pos += part.length
  }
  return result
}

/** Decode an account from bytes. */
export function decodeAccount(data: Uint8Array): Account {
  let offset = 0
  const [balance, s1] = decodeBigInt(data, offset); offset += s1
  const [nonce, s2] = decodeBigInt(data, offset); offset += s2
  const [reputation, s3] = decodeBigInt(data, offset); offset += s3
  return { balance, nonce, reputation }
}

// ── Receipt encoding ────────────────────────────────────────────────────

/** Encode a transaction receipt into deterministic bytes (for receipt-root hashing). */
export function encodeReceipt(receipt: TransactionReceipt): Uint8Array {
  const parts: Uint8Array[] = [
    encodeBytes(receipt.txHash),
    new Uint8Array([receipt.status === 'success' ? 1 : 0]),
    encodeBytes(encoder.encode(receipt.revertReason ?? '')),
    encodeBigInt(BigInt(receipt.index)),
  ]
  const totalLen = parts.reduce((sum, p) => sum + p.length, 0)
  const result = new Uint8Array(totalLen)
  let pos = 0
  for (const part of parts) {
    result.set(part, pos)
    pos += part.length
  }
  return result
}

// ── Block header encoding ─────────────────────────────────────────────

/** Big-endian 8-byte encoding of a bigint, for fixed-width header fields. */
function u64(value: bigint): Uint8Array {
  const hex = value.toString(16).padStart(16, '0')
  const bytes = new Uint8Array(8)
  for (let i = 0; i < 8; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

/**
 * Deterministic bytes for a block header.
 *
 * One definition, used both for the consensus digest and for the block hash
 * that links a block to its child -- if those two ever disagree, nodes are
 * agreeing on one thing and chaining another.
 */
export function encodeBlockHeader(header: BlockHeader): Uint8Array {
  const parts: Uint8Array[] = [
    u64(header.number),
    header.parentHash,
    header.stateRoot,
    header.txRoot,
    header.receiptRoot,
    u64(BigInt(header.timestamp)),
    header.proposer,
  ]
  const totalLen = parts.reduce((sum, p) => sum + p.length, 0)
  const result = new Uint8Array(totalLen)
  let pos = 0
  for (const part of parts) {
    result.set(part, pos)
    pos += part.length
  }
  return result
}

/**
 * The canonical hash of a block: SHA-256 over its encoded header.
 *
 * This is what a child block's `parentHash` must be. It commits to the
 * transactions (via `txRoot`), the execution result (`stateRoot`,
 * `receiptRoot`), the proposer and the timestamp, so "same height, different
 * history" is detectable from the headers alone.
 */
export async function blockHash(block: Block): Promise<Uint8Array> {
  return hash(encodeBlockHeader(block.header))
}
