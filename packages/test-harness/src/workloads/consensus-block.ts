/**
 * ConsensusBlockWorkload — drives N blocks through PBFT consensus.
 */

import type { Workload, WorkloadResult } from './base-workload.js'
import type { TestOrchestrator } from '../orchestrator.js'

export class ConsensusBlockWorkload implements Workload {
  readonly name = 'consensus-block'
  #blocks: number

  constructor(opts: { blocks: number }) {
    this.#blocks = opts.blocks
  }

  async run(orch: TestOrchestrator): Promise<WorkloadResult> {
    const errors: string[] = []
    let txSubmitted = 0
    let blocksProduced = 0

    for (let i = 0; i < this.#blocks; i++) {
      const ok = await orch.produceBlock()
      if (ok) {
        txSubmitted++
        blocksProduced++
      } else {
        errors.push(`Block ${i}: produceBlock failed (no leader or proposal rejected)`)
      }
    }

    return { txSubmitted, blocksProduced, errors }
  }
}
