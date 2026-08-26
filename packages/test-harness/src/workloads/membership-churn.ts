/**
 * MembershipChurnWorkload — crashes and restarts nodes during block production.
 */

import type { Workload, WorkloadResult } from './base-workload.js'
import type { TestOrchestrator } from '../orchestrator.js'

export interface ChurnEvent {
  afterBlock: number
  action: 'crash' | 'restart'
  nodeId: string
}

export class MembershipChurnWorkload implements Workload {
  readonly name = 'membership-churn'
  #blocks: number
  #events: ChurnEvent[]

  constructor(opts: { blocks: number; events: ChurnEvent[] }) {
    this.#blocks = opts.blocks
    this.#events = [...opts.events].sort((a, b) => a.afterBlock - b.afterBlock)
  }

  async run(orch: TestOrchestrator): Promise<WorkloadResult> {
    const errors: string[] = []
    let txSubmitted = 0
    let blocksProduced = 0
    let eventIdx = 0

    for (let blockNum = 0; blockNum < this.#blocks; blockNum++) {
      // Produce a block
      const ok = await orch.produceBlock()
      if (ok) {
        txSubmitted++
        blocksProduced++
      } else {
        // If no leader, try a view change
        await orch.advanceTime(11000)
        const retryOk = await orch.produceBlock()
        if (retryOk) {
          txSubmitted++
          blocksProduced++
        } else {
          errors.push(`Block ${blockNum}: could not produce (even after view change)`)
        }
      }

      // Process churn events scheduled after this block
      while (eventIdx < this.#events.length && this.#events[eventIdx].afterBlock <= blocksProduced) {
        const ev = this.#events[eventIdx]
        if (ev.action === 'crash') {
          const node = orch.nodes.get(ev.nodeId)
          if (node?.running) {
            orch.crashNode(ev.nodeId)

            // If we crashed the leader, trigger view change
            if (orch.findLeader() === null) {
              await orch.advanceTime(11000)
            }
          }
        } else if (ev.action === 'restart') {
          // orch.restartNode() seeds the restarted node's entire state
          // (balances, nonces, everything) from a live peer before it
          // rejoins consensus — no manual re-funding needed here anymore.
          // (Manually re-funding on top of that would double-count balances.)
          orch.restartNode(ev.nodeId)
        }
        eventIdx++
      }
    }

    return { txSubmitted, blocksProduced, errors }
  }
}
