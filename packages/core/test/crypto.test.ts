import { describe, it, expect } from 'vitest'
import { verifyEd25519, signEd25519, ed25519Verifier } from '../src/crypto.js'

async function keypair() {
  const kp = (await globalThis.crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair
  const publicKey = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', kp.publicKey))
  return { kp, publicKey }
}

const msg = new TextEncoder().encode('hello raijin')

describe('verifyEd25519(publicKey, signature, message)', () => {
  it('verifies a good signature', async () => {
    const { kp, publicKey } = await keypair()
    const signature = await signEd25519(kp.privateKey, msg)
    expect(await verifyEd25519(publicKey, signature, msg)).toBe(true)
  })

  it('returns false for a wrong message, wrong key, or corrupted signature', async () => {
    const a = await keypair()
    const b = await keypair()
    const signature = await signEd25519(a.kp.privateKey, msg)
    expect(await verifyEd25519(a.publicKey, signature, new TextEncoder().encode('other'))).toBe(false)
    expect(await verifyEd25519(b.publicKey, signature, msg)).toBe(false)
    expect(await verifyEd25519(a.publicKey, new Uint8Array(3), msg)).toBe(false)
  })

  it('throws a TypeError naming the new order when given the OLD (message, signature, publicKey) order', async () => {
    const { kp, publicKey } = await keypair()
    const signature = await signEd25519(kp.privateKey, msg)
    // old order: message is not 32 bytes -> would have been a silent false
    await expect(verifyEd25519(msg, signature, publicKey)).rejects.toThrow(TypeError)
    await expect(verifyEd25519(msg, signature, publicKey)).rejects.toThrow(/\(publicKey, signature, message\)/)
  })

  it('also catches the old order with a 64-byte "publicKey" (a signature in the key slot)', async () => {
    const { kp, publicKey } = await keypair()
    const signature = await signEd25519(kp.privateKey, publicKey)
    await expect(verifyEd25519(signature as unknown as Uint8Array, signature, publicKey)).rejects.toThrow(TypeError)
  })

  it('ed25519Verifier (SignatureVerifier) uses the new order', async () => {
    const { kp, publicKey } = await keypair()
    const signature = await signEd25519(kp.privateKey, msg)
    expect(await ed25519Verifier.verify(publicKey, signature, msg)).toBe(true)
    expect(await ed25519Verifier.verify(new Uint8Array(32), signature, msg)).toBe(false)
  })
})

describe('signEd25519(privateKey, message)', () => {
  it('is deterministic and 64 bytes', async () => {
    const { kp } = await keypair()
    const s1 = await signEd25519(kp.privateKey, msg)
    expect(s1.length).toBe(64)
    expect(await signEd25519(kp.privateKey, msg)).toEqual(s1)
  })

  it('accepts a raw 32-byte seed and matches the CryptoKey result', async () => {
    const { kp } = await keypair()
    const pkcs8 = new Uint8Array(await globalThis.crypto.subtle.exportKey('pkcs8', kp.privateKey))
    const seed = pkcs8.slice(pkcs8.length - 32)
    expect(await signEd25519(seed, msg)).toEqual(await signEd25519(kp.privateKey, msg))
  })

  it('throws on a wrong-length seed (including a swapped message in the key slot)', async () => {
    await expect(signEd25519(msg, new Uint8Array(32))).rejects.toThrow(TypeError)
  })
})
