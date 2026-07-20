import { getSimulationRunCount } from "../model-simulation-validator"
import { finalizeAndLockBenchmarks } from "./finalize-and-lock-benchmarks"
import type { ModelExecution } from "./model-execution"
import type { ModelRefinementState } from "./model-refinement-state"
import { updateServerProgress } from "./model-run-state"
import { clearRefinementArtifacts } from "./model-setup-state"

export type BenchmarkRepairOutcome = "not_needed" | "repaired" | "recovery_limit"

export async function repairBenchmarkLock(
  state: ModelRefinementState,
  execution: ModelExecution,
): Promise<BenchmarkRepairOutcome> {
  const benchmark_contract_error = state.final_champion?.benchmark_contract_error
  if (!benchmark_contract_error) return "not_needed"

  const configured_recoveries = Number(process.env.MODEL_BENCHMARK_RECOVERY_ATTEMPTS ?? 2)
  const maximum_recoveries = Number.isInteger(configured_recoveries)
    ? Math.max(0, Math.min(4, configured_recoveries))
    : 2
  if (state.benchmark_recovery_count >= maximum_recoveries) {
    state.final_error_message = `Benchmark circuit recovery limit reached: ${benchmark_contract_error}`
    return "recovery_limit"
  }

  state.benchmark_recovery_count += 1
  execution.context.model_run_store.pauseSegment(execution.model_run_id)
  execution.stopBudgetMonitor()
  execution.budget_exhausted = false
  execution.resetProcessController()
  await execution.append(
    "system",
    `Independent validation found a structural defect in the locked benchmark circuit. Pausing and discarding model refinement, then returning only the circuit harness for controlled repair (lock generation ${state.benchmark_lock.generation + 1}).\n`,
  )
  updateServerProgress(
    {
      model_run_id: execution.model_run_id,
      phase: "locking_benchmarks",
      message: `Repairing a structural benchmark defect in lock generation ${state.benchmark_lock.generation}`,
    },
    execution.context.model_run_store,
  )
  await clearRefinementArtifacts(execution.model_dir)
  const repaired = await finalizeAndLockBenchmarks({
    model_run_id: execution.model_run_id,
    job_id: execution.model_run.job_id,
    job_dir: execution.job_dir,
    model_dir: execution.model_dir,
    signal: execution.process_controller.signal,
    context: execution.context,
    append: execution.append.bind(execution),
    initial_feedback: benchmark_contract_error,
    repair_lock: state.benchmark_lock,
  })
  state.benchmark_lock = repaired.benchmark_lock
  execution.context.model_run_store.rememberBenchmarkLock(execution.model_run_id, state.benchmark_lock)
  const repaired_run_count = await getSimulationRunCount(execution.model_dir)
  execution.context.model_run_store.setValidationProfile(execution.model_run_id, {
    simulation_run_count: repaired_run_count,
  })
  execution.context.model_run_store.restartSegment(execution.model_run_id)
  execution.startBudgetMonitor()
  state.resetValidation()
  state.agent_attempt = 0
  await execution.append(
    "system",
    `Committed benchmark lock generation ${state.benchmark_lock.generation}; restarting model refinement from a clean time boundary.\n`,
  )
  return "repaired"
}
