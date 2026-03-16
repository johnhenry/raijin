/**
 * raijin-consensus — PBFT consensus and leader rotation for the Raijin mesh rollup.
 *
 * Implements a simplified Practical Byzantine Fault Tolerance protocol
 * with rotating leader selection and view changes for leader failure.
 *
 * Transport agnostic — inject your own NetworkTransport.
 * Timer agnostic — inject your own ConsensusTimer (for deterministic testing).
 */

export { PBFTConsensus } from './pbft.js'
export type { PBFTConfig } from './pbft.js'
export { ValidatorSet } from './validator-set.js'

export type {
  NetworkTransport,
  ConsensusTimer,
  TimerHandle,
  ConsensusMessage,
  PrePrepareMessage,
  PrepareMessage,
  CommitMessage,
  ViewChangeMessage,
  NewViewMessage,
} from './types.js'

export { PBFTPhase } from './types.js'
