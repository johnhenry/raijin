import { describe, it, expect } from 'vitest'
import type { Block } from '@johnhenry/raijin-core'
import { NoForkChecker } from '../src/checkers/no-fork.js'
import { GossipConvergenceChecker } from '../src/checkers/gossip-convergence.js'
import type { RaijinTestNode } from '../src/nodes/raijin-test-node.js'

/**
 * Before the stateRoot/receiptRoot fix (see pbft.ts#onCommitted and the
 * corresponding issue), block.header.stateRoot was ALWAYS 32 zero bytes,
 * which meant NoForkChecker/GossipConvergenceChecker could never actually
 * observe a divergence — every node's "state root" was identical by
 * construction, regardless of what state they were actually in. These
 * tests exercise the checkers directly with distinguishable (non-zero,
 * content-derived) state roots, which is the scenario that's now possible
 * to construct meaningfully.
 */

function makeBlock(number: bigint, stateRootByte: number): Block {
  const stateRoot = new Uint8Array(32)
  stateRoot[0] = stateRootByte
  return {
    header: {
      number,
      parentHash: new Uint8Array(32),
      stateRoot,
      txRoot: new Uint8Array(32),
      receiptRoot: new Uint8Array(32),
      timestamp: Date.now(),
      proposer: new Uint8Array(32),
    },
    transactions: [],
    signatures: [],
  }
}

/** Minimal duck-typed test double — the checkers only read `.finalizedBlocks` / `.running`. */
function fakeNode(blocks: Block[], running = true): RaijinTestNode {
  return { finalizedBlocks: blocks, running } as unknown as RaijinTestNode
}

describe('NoForkChecker', () => {
  it('passes when all nodes agree on the state root at every height', async () => {
    const nodes = new Map<string, RaijinTestNode>([
      ['a', fakeNode([makeBlock(1n, 7)])],
      ['b', fakeNode([makeBlock(1n, 7)])],
    ])
    const result = await new NoForkChecker().check(nodes)
    expect(result.passed).toBe(true)
  })

  it('detects a fork when two nodes finalize different blocks at the same height', async () => {
    const nodes = new Map<string, RaijinTestNode>([
      ['a', fakeNode([makeBlock(1n, 7)])],
      ['b', fakeNode([makeBlock(1n, 9)])], // different state root at the same height
    ])
    const result = await new NoForkChecker().check(nodes)
    expect(result.passed).toBe(false)
    expect(result.message.toLowerCase()).toContain('fork')
  })
})

describe('GossipConvergenceChecker', () => {
  it('passes when all running nodes are at the same height and state root', async () => {
    const nodes = new Map<string, RaijinTestNode>([
      ['a', fakeNode([makeBlock(1n, 5)])],
      ['b', fakeNode([makeBlock(1n, 5)])],
    ])
    const result = await new GossipConvergenceChecker().check(nodes)
    expect(result.passed).toBe(true)
  })

  it('detects state-root divergence between running nodes at the same height', async () => {
    const nodes = new Map<string, RaijinTestNode>([
      ['a', fakeNode([makeBlock(1n, 5)])],
      ['b', fakeNode([makeBlock(1n, 6)])],
    ])
    const result = await new GossipConvergenceChecker().check(nodes)
    expect(result.passed).toBe(false)
  })

  it('ignores stopped nodes when checking convergence', async () => {
    const nodes = new Map<string, RaijinTestNode>([
      ['a', fakeNode([makeBlock(1n, 5)])],
      ['b', fakeNode([makeBlock(1n, 5)])],
      ['c', fakeNode([makeBlock(1n, 99)], false)], // stopped — its divergent state shouldn't count
    ])
    const result = await new GossipConvergenceChecker().check(nodes)
    expect(result.passed).toBe(true)
  })
})
