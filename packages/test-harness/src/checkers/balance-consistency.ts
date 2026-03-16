/**
 * BalanceConsistencyChecker — verifies that the sum of all account balances
 * is the same across all nodes.
 */

import { toHex } from 'raijin-core'
import type { RaijinTestNode } from '../nodes/raijin-test-node.js'
import type { Checker, CheckResult } from '../orchestrator.js'

export class BalanceConsistencyChecker implements Checker {
  readonly name = 'balance-consistency'

  #accounts: Uint8Array[]

  /**
   * @param accounts - The set of account public keys to check balances for.
   */
  constructor(accounts: Uint8Array[]) {
    this.#accounts = accounts
  }

  async check(nodes: Map<string, RaijinTestNode>): Promise<CheckResult> {
    const nodeTotals = new Map<string, bigint>()

    for (const [nodeId, node] of nodes) {
      let total = 0n
      for (const account of this.#accounts) {
        const acct = await node.node.stateMachine.getAccount(account)
        total += acct.balance
      }
      nodeTotals.set(nodeId, total)
    }

    const totals = new Set(nodeTotals.values())

    if (totals.size > 1) {
      const details = Array.from(nodeTotals.entries())
        .map(([id, total]) => `  ${id}: ${total}`)
        .join('\n')
      return {
        passed: false,
        message: 'Balance totals differ across nodes',
        details,
      }
    }

    const total = nodeTotals.values().next().value
    return {
      passed: true,
      message: `All ${nodes.size} node(s) agree on total balance: ${total}`,
    }
  }
}
