/**
 * Ed25519 signature verification using globalThis.crypto.subtle (Web Crypto API).
 * Zero dependencies. Mirrors the signing side implemented by `Wallet` in
 * @johnhenry/raijin-sdk, which signs with `globalThis.crypto.subtle.sign('Ed25519', ...)`.
 *
 * Note: Web Crypto does not support Ed25519 in all environments.
 * Node.js 20+ and modern browsers support it. For older environments,
 * fall back to a polyfill.
 */

import type { SignatureVerifier } from './types.js'

// PKCS#8 prefix for a raw 32-byte Ed25519 seed (RFC 8410).
const PKCS8_ED25519_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
])

/**
 * Verify an Ed25519 signature. Argument order follows WebCrypto's
 * `verify(key, signature, data)`: `(publicKey, signature, message)`.
 *
 * BREAKING (core 0.1.0): earlier versions took `(message, signature,
 * publicKey)`. A swapped call used to return `false` silently; because a
 * public key is always 32 bytes, a `publicKey` of any other length now throws
 * a `TypeError` naming the new order instead.
 *
 * Returns false (never throws) if the signature is malformed or doesn't
 * match — callers should treat any non-true result as "reject this message."
 */
export async function verifyEd25519(
  publicKey: Uint8Array,
  signature: Uint8Array,
  message: Uint8Array,
): Promise<boolean> {
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) {
    throw new TypeError(
      'verifyEd25519: publicKey must be a 32-byte Uint8Array. The argument order changed to '
      + '(publicKey, signature, message) in @johnhenry/raijin-core 0.1.0 (was (message, signature, publicKey)) '
      + '-- check the call site.',
    )
  }
  try {
    const key = await globalThis.crypto.subtle.importKey(
      'raw',
      publicKey as BufferSource,
      'Ed25519',
      false,
      ['verify'],
    )
    return await globalThis.crypto.subtle.verify(
      'Ed25519',
      key,
      signature as BufferSource,
      message as BufferSource,
    )
  } catch {
    return false
  }
}

/**
 * Sign a message with Ed25519: `(privateKey, message)`, WebCrypto's
 * `sign(key, data)` order. `privateKey` is a Web Crypto Ed25519 private
 * `CryptoKey` or a raw 32-byte seed. Unlike verification this throws on bad
 * input: a silently failed signature is worse than an error.
 */
export async function signEd25519(
  privateKey: CryptoKey | Uint8Array,
  message: Uint8Array,
): Promise<Uint8Array> {
  let key: CryptoKey
  if (privateKey instanceof Uint8Array) {
    if (privateKey.length !== 32) {
      throw new TypeError(
        `signEd25519: raw private key must be a 32-byte seed, got ${privateKey.length} bytes `
        + '(argument order is (privateKey, message))',
      )
    }
    const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32)
    pkcs8.set(PKCS8_ED25519_PREFIX)
    pkcs8.set(privateKey, PKCS8_ED25519_PREFIX.length)
    key = await globalThis.crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', false, ['sign'])
  } else {
    key = privateKey
  }
  const sig = await globalThis.crypto.subtle.sign('Ed25519', key, message as BufferSource)
  return new Uint8Array(sig)
}

/** A `SignatureVerifier` backed by real Ed25519 verification. */
export const ed25519Verifier: SignatureVerifier = {
  verify: verifyEd25519,
}
