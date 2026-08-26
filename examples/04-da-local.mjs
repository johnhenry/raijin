/**
 * 04 — Data availability with LocalDA and encode/decode (@johnhenry/raijin-da)
 *
 * submit() returns a DACommitment (layer, height, index, content hash);
 * retrieve() gets the bytes back; verify() re-hashes what's stored and
 * compares against the commitment hash.
 *
 * encode()/decode() wrap payloads with a magic header and compress via
 * fflate WHEN INSTALLED (it's optional) — output differs between
 * environments with and without fflate, but decode() always handles the
 * raw form.
 *
 * Run: npm run example:04
 */
import assert from 'node:assert/strict'
import { LocalDA, encode, decode } from '@johnhenry/raijin-da'
import { equal, toHex } from '@johnhenry/raijin-core'

const da = new LocalDA()
const blockBytes = new TextEncoder().encode(JSON.stringify({ number: 1, txs: ['a', 'b'] }))

// Encode for DA submission (adds "RJC"/"RJR" magic; compresses if fflate present)
const encoded = await encode(blockBytes)
console.log('payload', blockBytes.length, 'bytes → encoded', encoded.length,
  'bytes (magic:', String.fromCharCode(...encoded.slice(0, 3)) + ')')

// Submit → commitment
const commitment = await da.submit(encoded)
console.log('commitment:', {
  layer: commitment.layer,
  height: commitment.height,
  index: commitment.index,
  hash: toHex(commitment.hash).slice(0, 16) + '…',
})
assert.equal(commitment.layer, 'local')

// Retrieve + decode round-trip
const retrieved = await da.retrieve(commitment)
const decoded = await decode(retrieved)
assert.ok(equal(decoded, blockBytes), 'round-trip must return the original bytes')
console.log('round-trip ok:', new TextDecoder().decode(decoded))

// verify() — true for a real commitment…
assert.equal(await da.verify(commitment), true)

// …false for a commitment whose hash matches nothing stored.
// Note what verify() proves: "this backend has bytes matching this hash".
// It does NOT prove inclusion at a particular height/index.
const forged = { ...commitment, hash: new Uint8Array(32) }
assert.equal(await da.verify(forged), false)
console.log('forged commitment verifies?', await da.verify(forged))

// Heights advance only when you say so (LocalDA simulates block boundaries).
// Storage is content-addressed: resubmitting identical bytes reuses the slot.
da.nextBlock()
const c2 = await da.submit(await encode(new TextEncoder().encode('block 2')))
assert.equal(c2.height, 1n)
console.log('after nextBlock(): height =', c2.height, 'stored blobs =', da.size)

console.log('04-da-local: OK')
