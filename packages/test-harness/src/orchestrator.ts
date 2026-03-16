/**
 * TestOrchestrator — manages a cluster of RaijinTestNodes with a shared
 * PartitionableNetwork and MockTimer for deterministic distributed testing.
 *
 * Two-phase setup: call addNode() for all nodes, then startAll() to construct
 * and start them. This ensures every node sees the same validator set.
 */

import { toHex } from 'raijin-core'
import {
  MockTimer,
  mockSign,
  mockVerifier,
  makeTestKey,
} from '../../consensus/test/helpers.js'
import { PartitionableNetwork } from './network/partitionable-network.js'
import { SeededPRNG } from './network/seeded-prng.js'
import { RaijinTestNode } from './nodes/raijin-test-node.js'
import { EventCollector } from './timeline/event-collector.js'
import { ReportGenerator, type ReportEntry } from './timeline/report-generator.js'

export interface Checker {
  name: string
  check(nodes: Map<string, RaijinTestNode>): Promise<CheckResult>
}

export interface CheckResult {
  passed: boolean
  message: string
  details?: string
}

export class TestOrchestrator {
  readonly network: PartitionableNetwork
  readonly timer: MockTimer
  readonly nodes = new Map<string, RaijinTestNode>()
  readonly events = new EventCollector()

  #validators: Uint8Array[] = []
  #nextIndex = 1
  #nodeKeys = new Map<string, Uint8Array>()
  #pendingNodes: string[] = []
  #built = false
  #nonces = new Map<string, bigint>()  // hex(from) → next nonce

  constructor(opts?: { seed?: number }) {
    this.network = new PartitionableNetwork()
    this.timer = new MockTimer()
    if (opts?.seed !== undefined) {
      this.network.setPRNG(new SeededPRNG(opts.seed))
    }
  }

  /**
   * Register a node ID. The actual RaijinTestNode is not constructed until
   * startAll() is called, so that every node sees the full validator set.
   */
  addNode(id: string): void {
    if (this.#built) throw new Error('Cannot add nodes after startAll()')
    const index = this.#nextIndex++
    const key = makeTestKey(index)
    this.#validators.push(key)
    this.#nodeKeys.set(id, key)
    this.#pendingNodes.push(id)
    this.events.record(id, 'lifecycle', 'node-registered', { index })
  }

  /**
   * Build and start all registered nodes. Each node receives the complete
   * validator set so consensus quorum calculations are consistent.
   */
  startAll(): void {
    if (!this.#built) {
      const validatorsCopy = [...this.#validators]
      for (const id of this.#pendingNodes) {
        const key = this.#nodeKeys.get(id)!
        const node = new RaijinTestNode({
          id,
          publicKey: key,
          sign: mockSign(key),
          verify: mockVerifier,
          transport: this.network.createTransport(key),
          timer: this.timer,
          validators: validatorsCopy,
          blockTime: 2000,
        })
        this.nodes.set(id, node)
        this.events.record(id, 'lifecycle', 'node-added', {})
      }
      this.#pendingNodes = []
      this.#built = true
    }

    for (const [id, node] of this.nodes) {
      if (!node.running) {
        node.start()
        this.events.record(id, 'lifecycle', 'node-started', {})
      }
    }
  }

  /** Fund an account on ALL nodes (for consistent initial state). */
  async fundAccount(account: Uint8Array, amount: bigint): Promise<void> {
    for (const [, node] of this.nodes) {
      await node.fund(account, amount)
    }
  }

  /** Fund a node's own key on all nodes. */
  async fundNode(nodeId: string, amount: bigint): Promise<void> {
    await this.fundAccount(this.getKey(nodeId), amount)
  }

  /** Get the public key for a node. */
  getKey(nodeId: string): Uint8Array {
    const key = this.#nodeKeys.get(nodeId)
    if (!key) throw new Error(`Unknown node: ${nodeId}`)
    return key
  }

  /** Crash a node: stop it and disconnect from the network. */
  crashNode(id: string): void {
    const node = this.nodes.get(id)
    if (!node) throw new Error(`Unknown node: ${id}`)
    node.crash()
    this.network.disconnect(node.publicKey)
    this.events.record(id, 'fault', 'node-crashed', {})
  }

  /**
   * Restart a crashed node with a fresh ValidatorNode but same key.
   * State is NOT preserved (fresh store). Caller must re-fund if needed.
   */
  restartNode(id: string): void {
    const key = this.#nodeKeys.get(id)
    if (!key) throw new Error(`Unknown node: ${id}`)

    const transport = this.network.reconnect(key)
    const newNode = new RaijinTestNode({
      id,
      publicKey: key,
      sign: mockSign(key),
      verify: mockVerifier,
      transport,
      timer: this.timer,
      validators: [...this.#validators],
      blockTime: 2000,
    })
    this.nodes.set(id, newNode)
    newNode.start()
    this.events.record(id, 'lifecycle', 'node-restarted', {})
  }

  /** Drain all pending messages in the network. */
  async drainAll(): Promise<number> {
    const count = await this.network.drainAll()
    return count
  }

  /**
   * Drain the network fully, yielding between passes to let fire-and-forget
   * async chains (PBFT signing, applyBlock) complete and enqueue their
   * outbound messages. Uses microtask yields, not wall-clock delays.
   */
  async drainFully(maxPasses = 30): Promise<number> {
    let total = 0
    for (let i = 0; i < maxPasses; i++) {
      const n = await this.drainAll()
      total += n
      // Yield to event loop — crypto.subtle.digest() (SHA-256 in PBFT)
      // is real async I/O, not a microtask. setTimeout(0) lets it complete.
      await new Promise(r => setTimeout(r, 0))
      const n2 = await this.drainAll()
      total += n2
      if (n === 0 && n2 === 0) break
    }
    return total
  }

  /** Partition: block messages between two groups (reversible). */
  partition(groupA: string[], groupB: string[]): void {
    const keysA = groupA.map(id => this.getKey(id))
    const keysB = groupB.map(id => this.getKey(id))
    this.network.partition(keysA, keysB)
    this.events.record('network', 'fault', 'partition', { groupA, groupB })
  }

  /** Heal all partitions (messages flow again). */
  healPartition(): void {
    this.network.healPartition()
    this.events.record('network', 'fault', 'partition-healed', {})
  }

  /** Advance the mock timer and drain messages. */
  async advanceTime(ms: number): Promise<void> {
    this.timer.advance(ms)
    this.network.advanceTime(ms)
    await this.drainFully()
  }

  /** Find the current leader node ID. */
  findLeader(): string | null {
    for (const [id, node] of this.nodes) {
      if (node.running && node.node.consensus.isLeader) {
        return id
      }
    }
    return null
  }

  /** Get the next nonce for an account (tracks across the orchestrator). */
  nextNonce(account: Uint8Array): bigint {
    const hex = toHex(account)
    const nonce = this.#nonces.get(hex) ?? 0n
    this.#nonces.set(hex, nonce + 1n)
    return nonce
  }

  /** Reset nonce tracking (e.g., after state reset). */
  resetNonces(): void {
    this.#nonces.clear()
  }

  /**
   * Convenience: find leader, submit a tx, propose block, drain.
   * Returns null if no leader or proposal fails.
   */
  async produceBlock(from?: Uint8Array, to?: Uint8Array, amount = 1n): Promise<boolean> {
    const leaderId = this.findLeader()
    if (!leaderId) return false
    const leader = this.nodes.get(leaderId)!

    const senderKey = from ?? this.#validators[0]
    const receiverKey = to ?? this.#validators[1 % this.#validators.length]
    const nonce = this.nextNonce(senderKey)

    await leader.submitTx(senderKey, receiverKey, amount, nonce)
    const block = await leader.proposeBlock()
    if (!block) return false
    await this.drainFully()
    return true
  }

  /** Run a checker against the current cluster state. */
  async check(checker: Checker): Promise<CheckResult> {
    const result = await checker.check(this.nodes)
    this.events.record('checker', 'check', checker.name, {
      passed: result.passed,
      message: result.message,
    })
    return result
  }

  /** Get running nodes only. */
  runningNodes(): Map<string, RaijinTestNode> {
    const running = new Map<string, RaijinTestNode>()
    for (const [id, node] of this.nodes) {
      if (node.running) running.set(id, node)
    }
    return running
  }

  /** Build a timeline of all recorded events. */
  buildTimeline(): ReturnType<EventCollector['getEvents']> {
    return this.events.getEvents()
  }

  /** Generate a summary report from check results. */
  generateReport(results: ReportEntry[]): string {
    return ReportGenerator.generate(results)
  }

  /** Get all validator keys. */
  get validatorKeys(): Uint8Array[] {
    return [...this.#validators]
  }
}
