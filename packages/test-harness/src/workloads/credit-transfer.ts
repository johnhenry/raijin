/**
 * CreditTransferWorkload — submits N transfers across nodes, packing
 * multiple transactions per block and driving block production.
 */

import type { Workload, WorkloadResult } from './base-workload.js'
import type { TestOrchestrator } from '../orchestrator.js'
import { SeededPRNG } from '../network/seeded-prng.js'

export class CreditTransferWorkload implements Workload {
  readonly name = 'credit-transfer'
  #transfers: number
  #txPerBlock: number
  #amount: bigint
  #prng: SeededPRNG

  constructor(opts: {
    transfers: number
    txPerBlock?: number
    amount?: bigint
    seed?: number
  }) {
    this.#transfers = opts.transfers
    this.#txPerBlock = opts.txPerBlock ?? 3
    this.#amount = opts.amount ?? 1n
    this.#prng = new SeededPRNG(opts.seed ?? 42)
  }

  async run(orch: TestOrchestrator): Promise<WorkloadResult> {
    const errors: string[] = []
    let txSubmitted = 0
    let blocksProduced = 0

    const keys = orch.validatorKeys
    if (keys.length < 2) {
      return { txSubmitted: 0, blocksProduced: 0, errors: ['Need at least 2 nodes'] }
    }

    let remaining = this.#transfers

    while (remaining > 0) {
      const leaderId = orch.findLeader()
      if (!leaderId) {
        errors.push(`No leader available at transfer ${txSubmitted}`)
        break
      }
      const leader = orch.nodes.get(leaderId)!

      // Submit a batch of txs
      const batchSize = Math.min(this.#txPerBlock, remaining)
      for (let i = 0; i < batchSize; i++) {
        const fromKey = this.#prng.pick(keys)
        let toKey = this.#prng.pick(keys)
        while (toKey === fromKey && keys.length > 1) {
          toKey = this.#prng.pick(keys)
        }
        const nonce = orch.nextNonce(fromKey)
        await leader.submitTx(fromKey, toKey, this.#amount, nonce)
        txSubmitted++
        remaining--
      }

      // Propose and drain
      const block = await leader.proposeBlock()
      if (block) {
        await orch.drainFully()
        blocksProduced++
      } else {
        errors.push(`Block proposal failed at transfer ${txSubmitted}`)
      }
    }

    return { txSubmitted, blocksProduced, errors }
  }
}
