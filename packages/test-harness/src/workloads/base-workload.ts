import type { TestOrchestrator } from '../orchestrator.js'

export interface WorkloadResult {
  txSubmitted: number
  blocksProduced: number
  errors: string[]
}

export interface Workload {
  readonly name: string
  run(orch: TestOrchestrator): Promise<WorkloadResult>
}
