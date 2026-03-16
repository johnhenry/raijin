/**
 * Wallet — Ed25519 key management and transaction signing.
 * Uses globalThis.crypto.subtle (Web Crypto API).
 *
 * Note: Web Crypto does not support Ed25519 in all environments.
 * Node.js 20+ and modern browsers support it. For older environments,
 * fall back to a polyfill or use ECDSA P-256 keys.
 */

import type { Transaction, TransactionSigner } from 'raijin-core'
import { encodeTx } from 'raijin-core'

export interface BuildTxOptions {
  to: Uint8Array | null
  value: bigint
  nonce: bigint
  data?: Uint8Array
  chainId?: bigint
}

export class Wallet implements TransactionSigner {
  #privateKey: CryptoKey
  #publicKeyBytes: Uint8Array

  private constructor(privateKey: CryptoKey, publicKeyBytes: Uint8Array) {
    this.#privateKey = privateKey
    this.#publicKeyBytes = publicKeyBytes
  }

  /** Generate a new Ed25519 keypair. */
  static async generate(): Promise<Wallet> {
    const keyPair = await globalThis.crypto.subtle.generateKey(
      'Ed25519',
      true, // extractable
      ['sign', 'verify'],
    ) as CryptoKeyPair

    const privateKey = keyPair.privateKey
    const publicKeyRaw = await globalThis.crypto.subtle.exportKey('raw', keyPair.publicKey)
    const publicKeyBytes = new Uint8Array(publicKeyRaw)

    return new Wallet(privateKey, publicKeyBytes)
  }

  /** Import an existing Ed25519 private key (PKCS8 format). */
  static async fromKey(pkcs8: Uint8Array): Promise<Wallet> {
    const privateKey = await globalThis.crypto.subtle.importKey(
      'pkcs8',
      pkcs8.buffer as ArrayBuffer,
      'Ed25519',
      true,
      ['sign'],
    )

    // Derive public key: export as JWK, import as public key, export raw
    const jwk = await globalThis.crypto.subtle.exportKey('jwk', privateKey)
    // Ed25519 JWK has 'x' as the public key component
    const publicKeyB64 = jwk.x!
    const publicKeyBytes = base64urlDecode(publicKeyB64)

    return new Wallet(privateKey, publicKeyBytes)
  }

  /** The wallet's public key (32 bytes). */
  get publicKey(): Uint8Array {
    return this.#publicKeyBytes
  }

  /** Sign arbitrary data with the private key. */
  async sign(message: Uint8Array): Promise<Uint8Array> {
    const signature = await globalThis.crypto.subtle.sign(
      'Ed25519',
      this.#privateKey,
      message.buffer as ArrayBuffer,
    )
    return new Uint8Array(signature)
  }

  /** Build and sign a transaction. */
  async buildTx(opts: BuildTxOptions): Promise<Transaction> {
    const tx: Transaction = {
      from: this.#publicKeyBytes,
      to: opts.to,
      value: opts.value,
      nonce: opts.nonce,
      data: opts.data ?? new Uint8Array(0),
      chainId: opts.chainId ?? 1n,
      signature: new Uint8Array(0), // placeholder
    }

    // Encode the transaction body (without signature) and sign it
    const txBytes = encodeTx(tx)
    tx.signature = await this.sign(txBytes)

    return tx
  }

  /** Export the private key as PKCS8 bytes. */
  async exportPrivateKey(): Promise<Uint8Array> {
    const pkcs8 = await globalThis.crypto.subtle.exportKey('pkcs8', this.#privateKey)
    return new Uint8Array(pkcs8)
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function base64urlDecode(str: string): Uint8Array {
  // Pad to multiple of 4
  const padded = str + '='.repeat((4 - (str.length % 4)) % 4)
  const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
