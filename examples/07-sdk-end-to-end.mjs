/**
 * 07 — SDK end-to-end against an in-process node (@johnhenry/raijin-sdk)
 *
 * The full path: Wallet (real Ed25519 via Web Crypto) → signed
 * transaction → RaijinClient → ClientTransport → ValidatorNode →
 * finalized block → receipt → account query. Signatures are actually
 * verified here, unlike the earlier examples.
 *
 * Run: npm run example:07
 */
import assert from 'node:assert/strict'
import {
  InMemoryStateStore,
  encodeAccount,
  encodeTxSigned,
  hash,
  equal,
  toHex,
} from '@johnhenry/raijin-core'
import { ValidatorNode } from '@johnhenry/raijin-validator'
import { RaijinClient, Wallet } from '@johnhenry/raijin-sdk'

// ── Real Ed25519 signature verification (Node 24+ / modern browsers) ──
const ed25519Verifier = {
  async verify(message, signature, publicKey) {
    try {
      const key = await globalThis.crypto.subtle.importKey(
        'raw', publicKey, { name: 'Ed25519' }, false, ['verify'],
      )
      return await globalThis.crypto.subtle.verify({ name: 'Ed25519' }, key, signature, message)
    } catch {
      return false
    }
  },
}

// ── Wallets ───────────────────────────────────────────────────────────
const validatorWallet = await Wallet.generate()
const userWallet = await Wallet.generate()
const merchant = new Uint8Array(32).fill(9)

// ── One in-process validator node ─────────────────────────────────────
const store = new InMemoryStateStore()
const prefix = new TextEncoder().encode('account:')
await store.put(
  new Uint8Array([...prefix, ...userWallet.publicKey]),
  encodeAccount({ balance: 1_000n, nonce: 0n, reputation: 0n }),
)

const node = new ValidatorNode({
  chainId: 1n,
  identity: {
    publicKey: validatorWallet.publicKey,
    sign: (msg) => validatorWallet.sign(msg),
    verify: ed25519Verifier,
  },
  transport: { broadcast() {}, send() {}, onMessage() {} },
  timer: { set: () => ({}), clear: () => {} }, // manual: we drive production below
  store,
  validators: [validatorWallet.publicKey],
})
node.start()

// ── A ClientTransport backed by the in-process node ───────────────────
// In a real deployment this is the network boundary (HTTP/WebRTC/…).
const transport = {
  async submitTransaction(tx) {
    // Receipt txHash is the canonical (signed) tx identifier — matches
    // the hash used for txRoot leaves and mempool dedup keys.
    const wantHash = await hash(encodeTxSigned(tx))
    const receiptPromise = new Promise((resolve) => {
      node.onBlockFinalized((_block, receipts) => {
        const r = receipts.find((r) => equal(r.txHash, wantHash))
        if (r) resolve(r)
      })
    })
    await node.submitTransaction(tx)
    await node.blockProducer.produceBlock() // manual timer → produce explicitly
    return receiptPromise
  },
  async getAccount(address) {
    return node.stateMachine.getAccount(address)
  },
  async getBlock(number) {
    const latest = node.latestBlock
    return latest && latest.header.number === number ? latest : null
  },
  onBlock(handler) {
    node.onBlockFinalized((block) => handler(block))
    return () => {}
  },
}

// ── The developer-facing surface ──────────────────────────────────────
const client = new RaijinClient(transport)

const unsub = client.subscribe((block) =>
  console.log('new block:', block.header.number, '| txs:', block.transactions.length))

// Build and sign a transfer — Wallet signs the canonical tx encoding
const tx = await userWallet.buildTx({ to: merchant, value: 250n, nonce: 0n, chainId: 1n })
assert.equal(tx.signature.length, 64)

const receipt = await client.submitTransaction(tx)
console.log('receipt:', receipt.status, toHex(receipt.txHash).slice(0, 16) + '…')
assert.equal(receipt.status, 'success')

// Query resulting state through the client
const user = await client.getAccount(userWallet.publicKey)
const shop = await client.getAccount(merchant)
assert.equal(user.balance, 750n)
assert.equal(user.nonce, 1n)
assert.equal(shop.balance, 250n)
console.log('user:', user, '\nmerchant:', shop)

const block1 = await client.getBlock(1n)
assert.ok(block1)
assert.equal(await client.getBlock(99n), null)

// A tampered transaction fails signature verification. The real mempool
// (@johnhenry/raijin-mempool) verifies signatures at submission time —
// stronger than catching it later at execution: the bad tx never makes
// it into a block at all.
const evil = await userWallet.buildTx({ to: merchant, value: 1n, nonce: 1n, chainId: 1n })
evil.value = 999n // mutate after signing
await assert.rejects(() => client.submitTransaction(evil), /rejected by mempool/)
console.log('tampered tx: rejected by mempool before ever reaching a block')

unsub()
node.stop()
console.log('07-sdk-end-to-end: OK')
