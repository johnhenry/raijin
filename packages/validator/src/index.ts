/**
 * @johnhenry/raijin-validator — Composition root wiring core, consensus, and mempool
 * into a runnable validator node.
 *
 * Depends on @johnhenry/raijin-core, @johnhenry/raijin-consensus, and
 * @johnhenry/raijin-mempool.
 */

export { ValidatorNode } from './validator.js'
export type { ValidatorNodeConfig } from './validator.js'

export { BlockProducer } from './block-producer.js'
export type { BlockProducerConfig } from './block-producer.js'

// Re-exported for convenience/back-compat — this is the real,
// signature-verified, fee-ordered mempool from @johnhenry/raijin-mempool.
export { Mempool } from '@johnhenry/raijin-mempool'
