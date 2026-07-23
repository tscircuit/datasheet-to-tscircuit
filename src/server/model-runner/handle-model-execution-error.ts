import { publishAvailableModelCheckpoint, restoreBestReportedModelCheckpoint } from "./model-checkpoint"
import { createUnverifiedFallbackModel } from "./create-unverified-fallback-model"
import type { ModelExecution } from "./model-execution"
import { updateServerProgress } from "./model-run-state"
import {
  ModelInfrastructureError,
  ModelProcessStaleError,
  ModelWorkspaceIsolationError,
} from "./stream-model-process"

export async function handleModelExecutionError(error: unknown, execution: ModelExecution): Promise<void> {
  execution.stopBudgetMonitor()
  if (execution.cancellation_signal.aborted) {
    await execution.preserveCancellation()
    return
  }

  const is_stale_error = error instanceof ModelProcessStaleError
  const is_infrastructure_error = error instanceof ModelInfrastructureError
  const error_message = is_stale_error
    ? "The model run timed out after producing no output."
    : error instanceof Error
      ? error.message
      : String(error)
  if (is_stale_error || error instanceof ModelWorkspaceIsolationError) {
    const restored_revision = await restoreBestReportedModelCheckpoint(execution.model_dir).catch(
      () => undefined,
    )
    if (restored_revision) {
      await execution
        .append(
          "system",
          `Restored reported champion ${restored_revision} after terminating the agent process tree.\n`,
        )
        .catch(() => undefined)
    }
  }
  await publishAvailableModelCheckpoint(
    { model_run_id: execution.model_run_id, model_dir: execution.model_dir },
    execution.context.model_run_store,
  ).catch(() => false)
  await execution
    .append(
      "system",
      `\n${
        is_stale_error
          ? "The model run timed out after producing no output"
          : is_infrastructure_error
            ? "The model run stopped safely because a server infrastructure check failed"
            : "SPICE model workflow failed"
      }: ${error_message}\n`,
    )
    .catch(() => undefined)
  let current_run = execution.context.model_run_store.getModelRun(execution.model_run_id)
  if (!current_run?.model_source) {
    const fallback = await createUnverifiedFallbackModel(execution)
    current_run = execution.context.model_run_store.updateModelRun(execution.model_run_id, fallback)
  }
  await execution
    .addWarning(`The best available SPICE output was published after recovery: ${error_message}`)
    .catch(() => undefined)
  const update = {
    status: "complete" as const,
    is_complete: true,
    has_errors: false,
    completed_at: new Date().toISOString(),
    error_message: undefined,
  }
  updateServerProgress(
    {
      model_run_id: execution.model_run_id,
      phase: "complete",
      message: "Best available SPICE output published with warnings",
    },
    execution.context.model_run_store,
  )
  if (current_run?.segment_started_at) {
    execution.context.model_run_store.finishSegment(execution.model_run_id, update)
  } else {
    execution.context.model_run_store.updateModelRun(execution.model_run_id, update)
  }
}
