/**
 * Canonical binary encoding for transactions and blocks.
 * Deterministic — same input always produces same bytes.
 * Zero dependencies.
 *
 * Two rules hold everywhere in this file, and they are what make an encoding
 * a *commitment* rather than merely a serialization:
 *
 * 1. **Every variable-length field carries its length.** Without a prefix,
 *    concatenation loses the boundary between adjacent fields and two
 *    different structures can flatten to the same bytes — the shape that made
 *    `{key: 0xab, value: "cd"}` and `{key: 0xabcd, value: ""}` share a state
 *    root, and that let a header with a 33-byte parentHash impersonate one
 *    with a 32-byte parentHash and a longer state root.
 * 2. **Every distinct structure carries a domain tag.** Without one, an
 *    encoding of one kind of thing can be reinterpreted as an encoding of
 *    another, so a signature or a Merkle leaf proves less than it appears to.
 *
 * `merkleRoot` in `hash.ts` follows the same convention (`0x00` leaves,
 * `0x01` internal nodes).
 */

import type { Transaction, Block, BlockHeader, Account, TransactionReceipt } from './types.js'
import { hash } from './hash.js'
import { RaijinError } from './errors.js'

const encoder = new TextEncoder()

// ── Domain separation ─────────────────────────────────────────────────

/**
 * One byte at the front of every canonically encoded structure, so no
 * structure's encoding can be read as another's.
 *
 * These bytes are consensus-critical: changing one changes every hash,
 * signature and root derived from that structure. Add new kinds with new
 * values; never reuse or renumber an existing one.
 */
export const Domain = {
  Transaction: 0x01,
  SignedTransaction: 0x02,
  Account: 0x03,
  Receipt: 0x04,
  BlockHeader: 0x05,
  StateEntry: 0x06,
} as const

export type DomainTag = (typeof Domain)[keyof typeof Domain]

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

/**
 * Encode an optional byte string: `0x00` when absent, `0x01` followed by the
 * length-prefixed bytes when present.
 *
 * "Absent" and "present but empty" are different values and must encode
 * differently — `to: null` (a system operation) is not `to: new
 * Uint8Array(0)` (a transfer to the empty address), and they used to sign the
 * same bytes.
 */
function encodeOptionalBytes(data: Uint8Array | null | undefined): Uint8Array {
  if (data === null || data === undefined) return new Uint8Array([0x00])
  const body = encodeBytes(data)
  const result = new Uint8Array(1 + body.length)
  result[0] = 0x01
  result.set(body, 1)
  return result
}

/** Concatenate parts, the first of which is conventionally the domain tag. */
function concat(parts: Uint8Array[]): Uint8Array {
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
 * Big-endian 8-byte encoding of a bigint, for fixed-width fields.
 *
 * Fixed width is only unambiguous inside its range: a value that does not fit
 * used to be silently truncated to its *high* 8 bytes, so two different block
 * numbers could encode identically. Out of range is an error instead.
 */
function u64(value: bigint): Uint8Array {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new RaijinError(`u64 out of range: ${value}`)
  }
  const hex = value.toString(16).padStart(16, '0')
  const bytes = new Uint8Array(8)
  for (let i = 0; i < 8; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

// ── Transaction encoding ──────────────────────────────────────────────

/** Encode a transaction into deterministic bytes (for hashing/signing). */
export function encodeTx(tx: Transaction): Uint8Array {
  return concat([
    new Uint8Array([Domain.Transaction]),
    encodeBytes(tx.from),
    encodeBigInt(tx.nonce),
    encodeOptionalBytes(tx.to),
    encodeBigInt(tx.value),
    encodeBytes(tx.data),
    encodeBigInt(tx.chainId),
  ])
}

/** Encode a transaction including its signature. */
export function encodeTxSigned(tx: Transaction): Uint8Array {
  return concat([
    new Uint8Array([Domain.SignedTransaction]),
    encodeTx(tx),
    encodeBytes(tx.signature),
  ])
}

// ── Account encoding ──────────────────────────────────────────────────

/** Encode an account to bytes. */
export function encodeAccount(account: Account): Uint8Array {
  return concat([
    new Uint8Array([Domain.Account]),
    encodeBigInt(account.balance),
    encodeBigInt(account.nonce),
    encodeBigInt(account.reputation),
  ])
}

/** Decode an account from bytes. Rejects bytes that encode something else. */
export function decodeAccount(data: Uint8Array): Account {
  if (data.length === 0 || data[0] !== Domain.Account) {
    throw new RaijinError(
      `Not an account encoding: expected domain tag 0x${Domain.Account.toString(16).padStart(2, '0')}, ` +
        `got ${data.length === 0 ? 'empty input' : `0x${data[0].toString(16).padStart(2, '0')}`}`,
    )
  }
  let offset = 1
  const [balance, s1] = decodeBigInt(data, offset); offset += s1
  const [nonce, s2] = decodeBigInt(data, offset); offset += s2
  const [reputation, s3] = decodeBigInt(data, offset); offset += s3
  return { balance, nonce, reputation }
}

// ── Receipt encoding ────────────────────────────────────────────────────

/** Encode a transaction receipt into deterministic bytes (for receipt-root hashing). */
export function encodeReceipt(receipt: TransactionReceipt): Uint8Array {
  return concat([
    new Uint8Array([Domain.Receipt]),
    encodeBytes(receipt.txHash),
    new Uint8Array([receipt.status === 'success' ? 1 : 0]),
    encodeOptionalBytes(
      receipt.revertReason === undefined ? null : encoder.encode(receipt.revertReason),
    ),
    encodeBigInt(BigInt(receipt.index)),
  ])
}

// ── State entry encoding ──────────────────────────────────────────────

/**
 * Deterministic bytes for one key→value pair of the state store.
 *
 * Exported so that any `StateStore` implementation — in-memory, IndexedDB,
 * OPFS — derives the same state root from the same contents. A store that
 * invents its own layout forks the chain from the ones that don't.
 */
export function encodeStateEntry(key: Uint8Array, value: Uint8Array): Uint8Array {
  return concat([new Uint8Array([Domain.StateEntry]), encodeBytes(key), encodeBytes(value)])
}

// ── Block header encoding ─────────────────────────────────────────────

/**
 * Deterministic bytes for a block header.
 *
 * One definition, used both for the consensus digest and for the block hash
 * that links a block to its child -- if those two ever disagree, nodes are
 * agreeing on one thing and chaining another.
 *
 * The four roots and the proposer key are length-prefixed. Nothing in the
 * type system pins them to 32 bytes, and unprefixed concatenation let a
 * header with a short parentHash and a long stateRoot produce the same bytes
 * — and so the same digest and the same block hash — as a header that split
 * those bytes differently.
 */
export function encodeBlockHeader(header: BlockHeader): Uint8Array {
  return concat([
    new Uint8Array([Domain.BlockHeader]),
    u64(header.number),
    encodeBytes(header.parentHash),
    encodeBytes(header.stateRoot),
    encodeBytes(header.txRoot),
    encodeBytes(header.receiptRoot),
    u64(BigInt(header.timestamp)),
    encodeBytes(header.proposer),
  ])
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
