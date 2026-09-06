// Run with: node --test packages/da/test/default-inflate.node.test.mjs
//
// The shipped fflate adapter, exercised against the real dependency.
//
// This is a plain node:test file rather than a vitest one, and that is not a
// preference. `getFflate()` loads the optional dependency through
// `Function('return import("fflate")')()` -- indirection that stops a bundler
// statically resolving an optional import. Vitest runs modules in a VM
// context with no dynamic-import callback, so that expression throws
// ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING there and `defaultInflate()` can
// never be reached. Measured under both the default pool and `--pool=forks`.
// In plain node it resolves fine.
//
// So every compressed-frame test in encoding.test.ts injects
// `DecodeOptions.inflate` -- node:zlib standing in for fflate -- and
// `defaultInflate()`, the ONLY place the memory bound exists in shipped code,
// had never executed. fflate was not even declared in package.json; the
// import simply always failed. Replacing the adapter's closure with a plain
// `fflate.inflateSync(body)`, reinstating the bug the module was written to
// fix, left all 41 DA tests green.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'fflate'
import { decode, DADecodeError } from '../dist/index.js'

const encoder = new TextEncoder()

/** Minimal LEB128, matching the frame format. */
function leb128(value) {
  const bytes = []
  let v = value
  do {
    let byte = v & 0x7f
    v >>>= 7
    if (v !== 0) byte |= 0x80
    bytes.push(byte)
  } while (v !== 0)
  return new Uint8Array(bytes)
}

function frame(declaredLength, compressed) {
  const header = leb128(declaredLength)
  const out = new Uint8Array(3 + header.length + compressed.length)
  out.set([0x52, 0x4a, 0x43], 0)
  out.set(header, 3)
  out.set(compressed, 3 + header.length)
  return out
}

test('round-trips a compressed frame through the shipped adapter', async () => {
  const payload = encoder.encode('a'.repeat(4096))
  // No `inflate` option: this is defaultInflate().
  const out = await decode(frame(payload.length, deflateSync(payload)))
  assert.deepEqual([...out], [...payload])
})

test('stops a frame that under-declares its size, inside the inflater', async () => {
  // Declare 1 KiB, hand over a stream that expands to 8 MiB. fflate refuses
  // to grow an `out` buffer the caller supplied, so this must throw rather
  // than allocate.
  const compressed = deflateSync(new Uint8Array(8 * 1024 * 1024))
  await assert.rejects(() => decode(frame(1024, compressed)), DADecodeError)
})
