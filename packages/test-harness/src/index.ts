/**
 * raijin-test-harness — distributed systems test harness wrapping real raijin packages.
 */

// Orchestrator
export { TestOrchestrator } from './orchestrator.js'
export type { Checker, CheckResult } from './orchestrator.js'

// Node
export { RaijinTestNode } from './nodes/raijin-test-node.js'
export type { RaijinTestNodeConfig } from './nodes/raijin-test-node.js'

// Network
export { PartitionableNetwork } from './network/partitionable-network.js'
export { SeededPRNG } from './network/seeded-prng.js'

// Checkers
export { NoForkChecker } from './checkers/no-fork.js'
export { BalanceConsistencyChecker } from './checkers/balance-consistency.js'
export { EventLogIntegrityChecker } from './checkers/event-log-integrity.js'
export { GossipConvergenceChecker } from './checkers/gossip-convergence.js'

// Workloads
export type { Workload, WorkloadResult } from './workloads/base-workload.js'
export { ConsensusBlockWorkload } from './workloads/consensus-block.js'
export { CreditTransferWorkload } from './workloads/credit-transfer.js'
export { MembershipChurnWorkload } from './workloads/membership-churn.js'
export type { ChurnEvent } from './workloads/membership-churn.js'

// Timeline
export { EventCollector } from './timeline/event-collector.js'
export type { TimelineEvent } from './timeline/event-collector.js'
export { ReportGenerator } from './timeline/report-generator.js'
export type { ReportEntry } from './timeline/report-generator.js'

// Re-export test helpers from consensus for convenience
export {
  DeterministicNetwork,
  MockTimer,
  MockNetwork,
  mockSign,
  mockVerifier,
  makeTestKey,
} from '../../consensus/test/helpers.js'
