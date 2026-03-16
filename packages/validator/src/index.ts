/**
 * raijin-validator — Composition root wiring core, consensus, and mempool
 * into a runnable validator node.
 *
 * Depends on raijin-core and raijin-consensus.
 */

export { ValidatorNode } from './validator.js'
export type { ValidatorNodeConfig } from './validator.js'

export { BlockProducer } from './block-producer.js'
export type { BlockProducerConfig } from './block-producer.js'

export { Mempool } from './mempool.js'
