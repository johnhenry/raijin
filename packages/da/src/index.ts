/**
 * raijin-da — Data availability abstraction with pluggable backends.
 *
 * Provides a uniform DALayer interface for submitting, retrieving, and
 * verifying data across different DA backends:
 *
 * - LocalDA: in-memory store for testing/dev
 * - CelestiaDA: Celestia light node client
 * - EthBlobDA: EIP-4844 blob submission (stub)
 */

// Types
export type { DALayer, DACommitment } from './types.js'

// Backends
export { LocalDA } from './local.js'
export { CelestiaDA } from './celestia.js'
export type { CelestiaDAOptions } from './celestia.js'
export { EthBlobDA } from './eth-blobs.js'
export type { EthBlobDAOptions } from './eth-blobs.js'

// Encoding
export { encode, decode } from './encoding.js'
