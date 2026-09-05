import { describe, it, expect } from 'vitest'
import { encodeTx, verifyEd25519 } from '@johnhenry/raijin-core'
import { Wallet } from '../src/wallet.js'

// ── Tests ──

describe('Wallet', () => {
  it('generates a new keypair', async () => {
    const wallet = await Wallet.generate()
    expect(wallet.publicKey).toBeInstanceOf(Uint8Array)
    expect(wallet.publicKey.length).toBe(32)
  })

  it('generates unique keypairs', async () => {
    const w1 = await Wallet.generate()
    const w2 = await Wallet.generate()
    expect(w1.publicKey).not.toEqual(w2.publicKey)
  })

  it('signs a message', async () => {
    const wallet = await Wallet.generate()
    const message = new Uint8Array([1, 2, 3, 4])
    const signature = await wallet.sign(message)
    expect(signature).toBeInstanceOf(Uint8Array)
    expect(signature.length).toBe(64) // Ed25519 signatures are 64 bytes
  })

  it('produces deterministic signatures', async () => {
    const wallet = await Wallet.generate()
    const message = new Uint8Array([1, 2, 3, 4])
    const sig1 = await wallet.sign(message)
    const sig2 = await wallet.sign(message)
    // Ed25519 is deterministic — same message + key → same signature
    expect(sig1).toEqual(sig2)
  })

  it('builds and signs a transaction', async () => {
    const wallet = await Wallet.generate()
    const recipient = new Uint8Array(32)
    recipient[0] = 42

    const tx = await wallet.buildTx({
      to: recipient,
      value: 100n,
      nonce: 0n,
      chainId: 1n,
    })

    expect(tx.from).toEqual(wallet.publicKey)
    expect(tx.to).toEqual(recipient)
    expect(tx.value).toBe(100n)
    expect(tx.nonce).toBe(0n)
    expect(tx.chainId).toBe(1n)
    expect(tx.signature.length).toBe(64)
  })

  it('builds a transaction with custom chainId', async () => {
    const wallet = await Wallet.generate()
    const tx = await wallet.buildTx({
      to: null,
      value: 0n,
      nonce: 5n,
      chainId: 42n,
      data: new Uint8Array([0x05]), // GovernancePropose
    })

    expect(tx.chainId).toBe(42n)
    expect(tx.nonce).toBe(5n)
    expect(tx.data).toEqual(new Uint8Array([0x05]))
  })

  it('exports and reimports a private key', async () => {
    const wallet = await Wallet.generate({ extractable: true })
    const pkcs8 = await wallet.exportPrivateKey()
    expect(pkcs8).toBeInstanceOf(Uint8Array)
    expect(pkcs8.length).toBeGreaterThan(0)

    const restored = await Wallet.fromKey(pkcs8)
    expect(restored.publicKey).toEqual(wallet.publicKey)
  })

  it('reimported wallet produces same signatures', async () => {
    const wallet = await Wallet.generate({ extractable: true })
    const pkcs8 = await wallet.exportPrivateKey()
    const restored = await Wallet.fromKey(pkcs8)

    const msg = new Uint8Array([10, 20, 30])
    const sig1 = await wallet.sign(msg)
    const sig2 = await restored.sign(msg)
    expect(sig1).toEqual(sig2)
  })
  // Regression: sign() used to pass `message.buffer`, which ignores
  // byteOffset/byteLength — so any Uint8Array that is a window into a larger
  // buffer was signed in full. verifyEd25519() passes the view, so the library
  // rejected its own signatures. See issue #20.
  it('signs the view, not the whole backing ArrayBuffer', async () => {
    const wallet = await Wallet.generate()

    const backing = new Uint8Array(64).fill(7)
    const view = backing.subarray(0, 32)
    const standalone = new Uint8Array(32).fill(7)

    const sigView = await wallet.sign(view)
    const sigStandalone = await wallet.sign(standalone)

    // Same 32 bytes, same signature — regardless of what surrounds them.
    expect(sigView).toEqual(sigStandalone)

    // The library verifies its own signature over the view...
    expect(await verifyEd25519(view, sigView, wallet.publicKey)).toBe(true)
    // ...and does NOT accept it over the 64-byte buffer it sits inside.
    expect(await verifyEd25519(backing, sigView, wallet.publicKey)).toBe(false)
  })

  it('reimports a PKCS8 key held in a larger buffer', async () => {
    const wallet = await Wallet.generate({ extractable: true })
    const pkcs8 = await wallet.exportPrivateKey()

    // Same bytes, but as a view with a non-zero byteOffset.
    const padded = new Uint8Array(pkcs8.length + 16)
    padded.set(pkcs8, 8)
    const view = padded.subarray(8, 8 + pkcs8.length)

    const restored = await Wallet.fromKey(view)
    expect(restored.publicKey).toEqual(wallet.publicKey)
  })
  // Convenient-but-unsafe defaults. See issue #23.
  describe('secure defaults', () => {
    it('generates a non-extractable private key by default', async () => {
      const wallet = await Wallet.generate()
      await expect(wallet.exportPrivateKey()).rejects.toThrow(/non-extractable/)
    })

    it('exports only when extractability was asked for', async () => {
      const wallet = await Wallet.generate({ extractable: true })
      const pkcs8 = await wallet.exportPrivateKey()
      expect(pkcs8.length).toBeGreaterThan(0)
    })

    it('a non-extractable wallet still signs', async () => {
      const wallet = await Wallet.generate()
      const sig = await wallet.sign(new Uint8Array([1, 2, 3]))
      expect(sig.length).toBe(64)
    })

    it('refuses to build a transaction with no chainId', async () => {
      const wallet = await Wallet.generate()
      await expect(
        // chainId is required at the type level; this is the JS caller.
        (wallet.buildTx as (o: unknown) => Promise<unknown>)({ to: null, value: 0n, nonce: 0n }),
      ).rejects.toThrow(/chainId is required/)
    })
  })
})
