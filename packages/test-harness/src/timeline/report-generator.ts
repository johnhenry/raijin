/**
 * ReportGenerator — generates summary text from check results.
 */

import type { CheckResult } from '../orchestrator.js'

export interface ReportEntry {
  checkerName: string
  result: CheckResult
}

export class ReportGenerator {
  /**
   * Generate a human-readable report from check results.
   */
  static generate(entries: ReportEntry[]): string {
    const lines: string[] = []
    lines.push('=== Test Harness Report ===')
    lines.push('')

    let passed = 0
    let failed = 0

    for (const entry of entries) {
      const status = entry.result.passed ? 'PASS' : 'FAIL'
      if (entry.result.passed) passed++
      else failed++

      lines.push(`[${status}] ${entry.checkerName}: ${entry.result.message}`)
      if (entry.result.details) {
        lines.push(entry.result.details)
      }
    }

    lines.push('')
    lines.push(`--- Summary: ${passed} passed, ${failed} failed, ${entries.length} total ---`)

    return lines.join('\n')
  }
}
