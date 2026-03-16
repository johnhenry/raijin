/**
 * NoForkChecker — verifies that all nodes that finalized blocks at
 * the same height have the same block (no forks).
 */

import { toHex } from 'raijin-core'
import type { RaijinTestNode } from '../nodes/raijin-test-node.js'
import type { Checker, CheckResult } from '../orchestrator.js'

export class NoForkChecker implements Checker {
  readonly name = 'no-fork'

  async check(nodes: Map<string, RaijinTestNode>): Promise<CheckResult> {
    // Group finalized blocks by height across all nodes
    const blocksByHeight = new Map<bigint, Map<string, string>>() // height → (nodeId → stateRootHex)

    for (const [nodeId, node] of nodes) {
      for (const block of node.finalizedBlocks) {
        const height = block.header.number
        if (!blocksByHeight.has(height)) {
          blocksByHeight.set(height, new Map())
        }
        const stateRoot = toHex(block.header.stateRoot)
        blocksByHeight.get(height)!.set(nodeId, stateRoot)
      }
    }

    // Check each height: all nodes that finalized at this height must have the same state root
    const forks: string[] = []

    for (const [height, nodeRoots] of blocksByHeight) {
      const roots = new Set(nodeRoots.values())
      if (roots.size > 1) {
        const details = Array.from(nodeRoots.entries())
          .map(([id, root]) => `  ${id}: ${root}`)
          .join('\n')
        forks.push(`Fork at height ${height}:\n${details}`)
      }
    }

    if (forks.length > 0) {
      return {
        passed: false,
        message: `Found ${forks.length} fork(s)`,
        details: forks.join('\n\n'),
      }
    }

    return {
      passed: true,
      message: `No forks detected across ${blocksByHeight.size} height(s) and ${nodes.size} node(s)`,
    }
  }
}
