/**
 * Wallet — Ed25519 key management and transaction signing.
 * Uses globalThis.crypto.subtle (Web Crypto API).
 *
 * Note: Web Crypto does not support Ed25519 in all environments.
 * Node.js 20+ and modern browsers support it. For older environments,
 * fall back to a polyfill or use ECDSA P-256 keys.
 */

import type { Transaction, TransactionSigner } from '@johnhenry/raijin-core'
import { encodeTx } from '@johnhenry/raijin-core'

export interface BuildTxOptions {
  to: Uint8Array | null
  value: bigint
  nonce: bigint
  data?: Uint8Array
  /**
   * Chain identifier. Required — it is the only thing in the transaction
   * format that separates one deployment from another, so a default would
   * make every chain that never chose one share an id, and a signed transfer
   * on either would be a valid signed transfer on the other for any account
   * whose key is shared between them.
   */
  chainId: bigint
}

export interface GenerateOptions {
  /**
   * Whether the private key can be exported with `exportPrivateKey()`.
   * Default: `false`.
   *
   * Raijin's stated environment is the browser, where a non-extractable
   * `CryptoKey` is the strongest guarantee WebCrypto offers: the key cannot
   * leave the browser, whatever script asks. An extractable key is one
   * `crypto.subtle.exportKey` call away from any code running in the origin.
   * Turn this on only when the key genuinely has to be persisted or moved.
   */
  extractable?: boolean
}

export class Wallet implements TransactionSigner {
  #privateKey: CryptoKey
  #publicKeyBytes: Uint8Array

  private constructor(privateKey: CryptoKey, publicKeyBytes: Uint8Array) {
    this.#privateKey = privateKey
    this.#publicKeyBytes = publicKeyBytes
  }

  /**
   * Generate a new Ed25519 keypair. The private key is **non-extractable**
   * unless `{ extractable: true }` is passed — see `GenerateOptions`.
   */
  static async generate(opts: GenerateOptions = {}): Promise<Wallet> {
    const extractable = opts.extractable ?? false
    const keyPair = await globalThis.crypto.subtle.generateKey(
      'Ed25519',
      extractable,
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
      // Pass the view, not `.buffer` — a Uint8Array that is a window into a
      // larger ArrayBuffer would otherwise import the whole buffer.
      pkcs8 as BufferSource,
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
      // Pass the view itself. `message.buffer` ignores byteOffset/byteLength,
      // so any Uint8Array produced by `subarray()` or backed by a pooled
      // buffer would be signed in full — bytes the caller never saw, and
      // bytes `verifyEd25519` (which passes the view) would not verify.
      message as BufferSource,
    )
    return new Uint8Array(signature)
  }

  /** Build and sign a transaction. */
  async buildTx(opts: BuildTxOptions): Promise<Transaction> {
    // Guard the JS callers the type system does not reach: an undefined
    // chainId would otherwise be encoded as a chain id of its own.
    if (typeof opts.chainId !== 'bigint') {
      throw new TypeError('Wallet.buildTx: chainId is required and must be a bigint')
    }

    const tx: Transaction = {
      from: this.#publicKeyBytes,
      to: opts.to,
      value: opts.value,
      nonce: opts.nonce,
      data: opts.data ?? new Uint8Array(0),
      chainId: opts.chainId,
      signature: new Uint8Array(0), // placeholder
    }

    // Encode the transaction body (without signature) and sign it
    const txBytes = encodeTx(tx)
    tx.signature = await this.sign(txBytes)

    return tx
  }

  /**
   * Export the private key as PKCS8 bytes.
   * Throws unless the wallet was created with `{ extractable: true }`.
   */
  async exportPrivateKey(): Promise<Uint8Array> {
    if (!this.#privateKey.extractable) {
      throw new Error(
        'Wallet.exportPrivateKey: this key is non-extractable. ' +
        'Pass Wallet.generate({ extractable: true }) if the key has to leave the process.',
      )
    }
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
