/**
 * GossipConvergenceChecker — verifies all running nodes converge to the
 * same chain (same latest block height and state root).
 */

import { toHex } from 'raijin-core'
import type { RaijinTestNode } from '../nodes/raijin-test-node.js'
import type { Checker, CheckResult } from '../orchestrator.js'

export class GossipConvergenceChecker implements Checker {
  readonly name = 'gossip-convergence'

  async check(nodes: Map<string, RaijinTestNode>): Promise<CheckResult> {
    const running = Array.from(nodes.entries()).filter(([, n]) => n.running)

    if (running.length < 2) {
      return { passed: true, message: 'Fewer than 2 running nodes — nothing to compare' }
    }

    const heights = new Map<string, bigint>()
    const stateRoots = new Map<string, string>()

    for (const [id, node] of running) {
      const blocks = node.finalizedBlocks
      const height = blocks.length > 0 ? blocks[blocks.length - 1].header.number : 0n
      heights.set(id, height)
      if (blocks.length > 0) {
        stateRoots.set(id, toHex(blocks[blocks.length - 1].header.stateRoot))
      }
    }

    const uniqueHeights = new Set(heights.values())
    const uniqueRoots = new Set(stateRoots.values())

    const violations: string[] = []

    if (uniqueHeights.size > 1) {
      const details = Array.from(heights.entries())
        .map(([id, h]) => `  ${id}: height=${h}`)
        .join('\n')
      violations.push(`Height divergence:\n${details}`)
    }

    if (uniqueRoots.size > 1) {
      const details = Array.from(stateRoots.entries())
        .map(([id, root]) => `  ${id}: stateRoot=${root.slice(0, 16)}...`)
        .join('\n')
      violations.push(`State root divergence:\n${details}`)
    }

    if (violations.length > 0) {
      return {
        passed: false,
        message: `Convergence failure across ${running.length} running node(s)`,
        details: violations.join('\n\n'),
      }
    }

    const height = heights.values().next().value
    return {
      passed: true,
      message: `All ${running.length} running node(s) converged at height ${height}`,
    }
  }
}
