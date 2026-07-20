import { join } from "node:path"
import type { ModelExecution } from "./model-execution"
import { summarizeValidationFeedback } from "./model-process-output"
import type { ModelRefinementState } from "./model-refinement-state"

export async function writeModelValidationFeedback(
  state: ModelRefinementState,
  execution: ModelExecution,
): Promise<void> {
  const simulation_failures =
    state.final_champion?.simulation_verifications.filter((verification) => !verification.passed) ?? []
  const score_failures = state.final_validation?.benchmarks.filter((benchmark) => !benchmark.passed) ?? []
  const scoring_status = state.final_validation
    ? score_failures.length > 0
      ? score_failures
          .map(
            (failure) =>
              `- ${failure.benchmark_id}: ${summarizeValidationFeedback(
                failure.error_message,
                `NRMSE ${failure.normalized_rmse}`,
              )}`,
          )
          .join("\n")
      : "- None"
    : "- Not scored because independent simulation validation is incomplete."
  state.final_error_message =
    state.model_integrity_error ??
    state.causal_shift_error ??
    state.final_champion?.integration_error ??
    state.final_error_message ??
    `${score_failures.length} of ${state.final_validation?.benchmark_count ?? 0} benchmarks failed scoring.`

  await Bun.write(
    join(execution.model_dir, "validation-feedback.md"),
    `# Server validation feedback

Validation is not complete. Fix the model without changing the server-locked benchmark manifest,
circuits, evidence, tolerances, or transient waveform definitions.

The exact server-run outputs are saved in \`simulation-validation.json\` and
\`validation-artifacts/<benchmark-id>/\`. Inspect those Circuit JSON files and extracted curves before
changing the model.

## Simulation failures

${
  simulation_failures.length > 0
    ? simulation_failures
        .map(
          (failure) =>
            `- ${failure.benchmark_id}: ${summarizeValidationFeedback(
              failure.error_message,
              "simulation verification failed",
            )}`,
        )
        .join("\n")
    : "- None"
}

## Scoring failures

${scoring_status}

## Model integrity review

${state.model_integrity_error ? `- ${state.model_integrity_error}` : "- Passed"}

## Causal stimulus-shift check

${state.causal_shift_error ? `- ${state.causal_shift_error}` : "- Passed or not required"}
`,
  )
  await execution.append(
    "system",
    `Independent validation is not at 100%: ${simulation_failures.length} simulation verification failure(s), ${score_failures.length} scoring failure(s)${state.model_integrity_error ? ", model integrity review failed" : ""}${state.causal_shift_error ? ", causal stimulus-shift check failed" : ""}.\n`,
  )
}
