import { describe, it, expect } from 'vitest'
import { encodeTx } from 'raijin-core'
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
    })

    expect(tx.from).toEqual(wallet.publicKey)
    expect(tx.to).toEqual(recipient)
    expect(tx.value).toBe(100n)
    expect(tx.nonce).toBe(0n)
    expect(tx.chainId).toBe(1n) // default
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
    const wallet = await Wallet.generate()
    const pkcs8 = await wallet.exportPrivateKey()
    expect(pkcs8).toBeInstanceOf(Uint8Array)
    expect(pkcs8.length).toBeGreaterThan(0)

    const restored = await Wallet.fromKey(pkcs8)
    expect(restored.publicKey).toEqual(wallet.publicKey)
  })

  it('reimported wallet produces same signatures', async () => {
    const wallet = await Wallet.generate()
    const pkcs8 = await wallet.exportPrivateKey()
    const restored = await Wallet.fromKey(pkcs8)

    const msg = new Uint8Array([10, 20, 30])
    const sig1 = await wallet.sign(msg)
    const sig2 = await restored.sign(msg)
    expect(sig1).toEqual(sig2)
  })
})
