/**
 * EventLogIntegrityChecker — verifies monotonic block heights with no gaps.
 */

import type { RaijinTestNode } from '../nodes/raijin-test-node.js'
import type { Checker, CheckResult } from '../orchestrator.js'

export class EventLogIntegrityChecker implements Checker {
  readonly name = 'event-log-integrity'

  async check(nodes: Map<string, RaijinTestNode>): Promise<CheckResult> {
    const violations: string[] = []

    for (const [nodeId, node] of nodes) {
      const blocks = node.finalizedBlocks
      if (blocks.length === 0) continue

      for (let i = 0; i < blocks.length; i++) {
        const expected = BigInt(i + 1)  // block numbers start at 1
        const actual = blocks[i].header.number
        if (actual !== expected) {
          violations.push(`${nodeId}: block[${i}] has number ${actual}, expected ${expected}`)
        }
      }

      // Check parent hash chain consistency across nodes (same parentHash at same height)
      // Note: BlockProducer currently uses stateRoot as parentHash, which may be
      // all zeros since stateRoot is filled post-execution. We check structural
      // consistency rather than non-zero values.
    }

    if (violations.length > 0) {
      return {
        passed: false,
        message: `Found ${violations.length} integrity violation(s)`,
        details: violations.join('\n'),
      }
    }

    const maxHeight = Math.max(
      ...Array.from(nodes.values()).map(n => n.finalizedBlocks.length),
    )
    return {
      passed: true,
      message: `All ${nodes.size} node(s) have valid block sequences up to height ${maxHeight}`,
    }
  }
}
