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

/**
 * Verify an Ed25519 signature.
 * Returns false (never throws) if the public key or signature is malformed,
 * or if the signature doesn't match — callers should treat any non-true
 * result as "reject this message."
 */
export async function verifyEd25519(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): Promise<boolean> {
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

/** A `SignatureVerifier` backed by real Ed25519 verification. */
export const ed25519Verifier: SignatureVerifier = {
  verify: verifyEd25519,
}
