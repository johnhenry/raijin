import { describe, it, expect, beforeEach } from 'vitest'
import {
  StateMachine,
  InMemoryStateStore,
  TransactionType,
  encodeTx,
  hash,
  type Transaction,
  type SignatureVerifier,
} from '../src/index.js'

// ── Mock signature verifier (always valid) ──

const alwaysValidVerifier: SignatureVerifier = {
  async verify() { return true },
}

const alwaysInvalidVerifier: SignatureVerifier = {
  async verify() { return false },
}

// ── Helpers ──

function makeAddress(id: number): Uint8Array {
  const addr = new Uint8Array(32)
  addr[0] = id
  return addr
}

function makeTransfer(from: Uint8Array, to: Uint8Array, value: bigint, nonce: bigint): Transaction {
  return {
    from,
    to,
    value,
    nonce,
    data: new Uint8Array([TransactionType.Transfer]),
    signature: new Uint8Array(64),
    chainId: 1n,
  }
}

function makeAttestation(from: Uint8Array, to: Uint8Array, nonce: bigint): Transaction {
  return {
    from,
    to,
    value: 0n,
    nonce,
    data: new Uint8Array([TransactionType.ReputationAttest]),
    signature: new Uint8Array(64),
    chainId: 1n,
  }
}

// ── Tests ──

describe('StateMachine', () => {
  let store: InMemoryStateStore
  let sm: StateMachine
  const alice = makeAddress(1)
  const bob = makeAddress(2)

  beforeEach(async () => {
    store = new InMemoryStateStore()
    sm = new StateMachine(store, alwaysValidVerifier)
  })

  describe('getAccount', () => {
    it('returns zero account for unknown address', async () => {
      const account = await sm.getAccount(alice)
      expect(account.balance).toBe(0n)
      expect(account.nonce).toBe(0n)
      expect(account.reputation).toBe(0n)
    })
  })

  describe('stateRoot', () => {
    it('returns deterministic root for empty state', async () => {
      const root1 = await sm.stateRoot()
      const root2 = await sm.stateRoot()
      expect(root1).toEqual(root2)
    })

    it('root changes after state modification', async () => {
      const root1 = await sm.stateRoot()
      // Fund alice directly in the store
      const { encodeAccount } = await import('../src/encoding.js')
      const key = new TextEncoder().encode('account:')
      const fullKey = new Uint8Array(key.length + alice.length)
      fullKey.set(key, 0)
      fullKey.set(alice, key.length)
      await store.put(fullKey, encodeAccount({ balance: 100n, nonce: 0n, reputation: 0n }))
      const root2 = await sm.stateRoot()
      expect(root1).not.toEqual(root2)
    })
  })

  describe('transfer', () => {
    beforeEach(async () => {
      // Fund alice with 1000
      const { encodeAccount } = await import('../src/encoding.js')
      const key = new TextEncoder().encode('account:')
      const fullKey = new Uint8Array(key.length + alice.length)
      fullKey.set(key, 0)
      fullKey.set(alice, key.length)
      await store.put(fullKey, encodeAccount({ balance: 1000n, nonce: 0n, reputation: 0n }))
    })

    it('transfers value from sender to recipient', async () => {
      const tx = makeTransfer(alice, bob, 100n, 0n)
      const receipt = await sm.applyTransaction(tx, 0)

      expect(receipt.status).toBe('success')

      const aliceAccount = await sm.getAccount(alice)
      expect(aliceAccount.balance).toBe(900n)
      expect(aliceAccount.nonce).toBe(1n)

      const bobAccount = await sm.getAccount(bob)
      expect(bobAccount.balance).toBe(100n)
    })

    it('rejects transfer with insufficient balance', async () => {
      const tx = makeTransfer(alice, bob, 2000n, 0n)
      const receipt = await sm.applyTransaction(tx, 0)

      expect(receipt.status).toBe('revert')
      expect(receipt.revertReason).toContain('insufficient balance')
    })

    it('rejects transfer with wrong nonce', async () => {
      const tx = makeTransfer(alice, bob, 100n, 5n) // wrong nonce
      const receipt = await sm.applyTransaction(tx, 0)

      expect(receipt.status).toBe('revert')
      expect(receipt.revertReason).toContain('nonce mismatch')
    })

    it('rejects transfer without recipient', async () => {
      const tx: Transaction = {
        from: alice,
        to: null,
        value: 100n,
        nonce: 0n,
        data: new Uint8Array([TransactionType.Transfer]),
        signature: new Uint8Array(64),
        chainId: 1n,
      }
      const receipt = await sm.applyTransaction(tx, 0)
      expect(receipt.status).toBe('revert')
      expect(receipt.revertReason).toContain('recipient')
    })

    it('processes sequential transfers with incrementing nonces', async () => {
      const tx1 = makeTransfer(alice, bob, 100n, 0n)
      const tx2 = makeTransfer(alice, bob, 200n, 1n)

      const r1 = await sm.applyTransaction(tx1, 0)
      const r2 = await sm.applyTransaction(tx2, 1)

      expect(r1.status).toBe('success')
      expect(r2.status).toBe('success')

      const aliceAccount = await sm.getAccount(alice)
      expect(aliceAccount.balance).toBe(700n)
      expect(aliceAccount.nonce).toBe(2n)

      const bobAccount = await sm.getAccount(bob)
      expect(bobAccount.balance).toBe(300n)
    })
  })

  describe('signature verification', () => {
    it('rejects transaction with invalid signature', async () => {
      const badSm = new StateMachine(store, alwaysInvalidVerifier)
      const tx = makeTransfer(alice, bob, 100n, 0n)
      const receipt = await badSm.applyTransaction(tx, 0)

      expect(receipt.status).toBe('revert')
      expect(receipt.revertReason).toContain('invalid signature')
    })
  })

  describe('reputation attestation', () => {
    beforeEach(async () => {
      const { encodeAccount } = await import('../src/encoding.js')
      const key = new TextEncoder().encode('account:')
      const fullKey = new Uint8Array(key.length + alice.length)
      fullKey.set(key, 0)
      fullKey.set(alice, key.length)
      await store.put(fullKey, encodeAccount({ balance: 100n, nonce: 0n, reputation: 10n }))
    })

    it('transfers reputation from attester to target', async () => {
      const tx = makeAttestation(alice, bob, 0n)
      const receipt = await sm.applyTransaction(tx, 0)

      expect(receipt.status).toBe('success')

      const aliceAccount = await sm.getAccount(alice)
      expect(aliceAccount.reputation).toBe(9n)

      const bobAccount = await sm.getAccount(bob)
      expect(bobAccount.reputation).toBe(1n)
    })

    it('rejects attestation with zero reputation', async () => {
      // Bob has no reputation
      const tx = makeAttestation(bob, alice, 0n)
      const receipt = await sm.applyTransaction(tx, 0)

      expect(receipt.status).toBe('revert')
      expect(receipt.revertReason).toContain('insufficient reputation')
    })
  })

  describe('applyBlock', () => {
    beforeEach(async () => {
      const { encodeAccount } = await import('../src/encoding.js')
      const key = new TextEncoder().encode('account:')
      const fullKey = new Uint8Array(key.length + alice.length)
      fullKey.set(key, 0)
      fullKey.set(alice, key.length)
      await store.put(fullKey, encodeAccount({ balance: 1000n, nonce: 0n, reputation: 5n }))
    })

    it('applies all transactions in a block', async () => {
      const block = {
        header: {
          number: 1n,
          parentHash: new Uint8Array(32),
          stateRoot: new Uint8Array(32),
          txRoot: new Uint8Array(32),
          receiptRoot: new Uint8Array(32),
          timestamp: Date.now(),
          proposer: alice,
        },
        transactions: [
          makeTransfer(alice, bob, 100n, 0n),
          makeTransfer(alice, bob, 200n, 1n),
        ],
        signatures: [],
      }

      const receipts = await sm.applyBlock(block)
      expect(receipts).toHaveLength(2)
      expect(receipts[0].status).toBe('success')
      expect(receipts[1].status).toBe('success')

      const aliceAccount = await sm.getAccount(alice)
      expect(aliceAccount.balance).toBe(700n)
    })
  })
})
