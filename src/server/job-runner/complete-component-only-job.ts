import type { ApprovedJobEvidence } from "./run-evidence-phase"
import type { JobExecution } from "./job-execution"

export async function completeComponentOnlyJob(
  evidence: ApprovedJobEvidence,
  execution: JobExecution,
): Promise<void> {
  execution.updateValidation({
    application_build: "not_applicable",
    application_connectivity: "not_applicable",
    application_schematic: "not_applicable",
    application_visual: "not_applicable",
  })
  await execution.append(
    "system",
    "No datasheet typical application was found by either evidence pass. Completing with the validated component only.\n",
  )
  execution.context.job_store.updateJob(execution.job_id, {
    display_status: "complete",
    is_complete: true,
    has_errors: false,
    completed_at: new Date().toISOString(),
    component_ready: true,
  })
}
