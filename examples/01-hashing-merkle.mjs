/**
 * 01 — Hashing and Merkle roots (@johnhenry/raijin-core)
 *
 * SHA-256 over crypto.subtle, Merkle roots over leaf hashes, and hex
 * round-trips. Everything is async because Web Crypto is async.
 *
 * Run: npm run example:01
 */
import assert from 'node:assert/strict'
import { hash, hashString, merkleRoot, equal, toHex, fromHex } from '@johnhenry/raijin-core'

// SHA-256 of raw bytes and of a UTF-8 string
const digest = await hash(new Uint8Array([1, 2, 3]))
assert.equal(digest.length, 32)
console.log('hash([1,2,3])      =', toHex(digest))

const strDigest = await hashString('raijin')
console.log('hashString(raijin) =', toHex(strDigest))

// Merkle root over leaf hashes
const leaves = [
  await hashString('tx-a'),
  await hashString('tx-b'),
  await hashString('tx-c'), // odd count — the last node is promoted, not duplicated
]
const root = await merkleRoot(leaves)
console.log('merkleRoot(3)      =', toHex(root))

// Leaf order matters — a Merkle root commits to the ordering
const swapped = await merkleRoot([leaves[1], leaves[0], leaves[2]])
assert.ok(!equal(root, swapped), 'reordering leaves must change the root')

// Edge cases: a single leaf is still hashed (a leaf is never itself a root),
// and empty input has its own root
assert.ok(!equal(await merkleRoot([leaves[0]]), leaves[0]))
assert.equal((await merkleRoot([leaves[0]])).length, 32)
assert.equal((await merkleRoot([])).length, 32)

// An odd leaf count is padded by promoting the last node, not by duplicating
// the last leaf — so a duplicated final transaction is a different root.
assert.ok(!equal(root, await merkleRoot([...leaves, leaves[2]])),
  'duplicating the last leaf must change the root')

// Hex round-trip
const hex = toHex(root)
assert.ok(equal(fromHex(hex), root))
console.log('hex round-trip ok  =', hex.slice(0, 16) + '…')

console.log('01-hashing-merkle: OK')
