import { runModel } from "../model-runner"
import { ModelRunApiContext } from "./model-run-api-context"
import { errorResponse, getJobId, jsonResponse, readEffort } from "./model-run-api-responses"
import { getModelRun } from "./get-model-run"

export async function extendModelRun(request: Request, context: ModelRunApiContext): Promise<Response> {
  const job_id = getJobId(new URL(request.url))
  if (!job_id) {
    return errorResponse({ error_code: "job_id_required", message: "job_id is required.", status: 400 })
  }
  const current_run = context.model_run_store.getModelRunForJob(job_id)
  if (!current_run) {
    return errorResponse({
      error_code: "model_run_not_found",
      message: "This job has no SPICE model run.",
      status: 404,
    })
  }
  if (current_run.status === "validating" || current_run.status === "cancelling") {
    return errorResponse({
      error_code: "model_run_busy",
      message: "Wait for the current model-run phase to finish.",
      status: 409,
    })
  }
  const additional_effort = await readEffort(request, "additional_effort")
  if (!additional_effort) {
    return errorResponse({
      error_code: "invalid_effort",
      message: "additional_effort must be an integer from 1 through 8.",
      status: 400,
    })
  }
  const result = context.model_run_store.extendModelRun(current_run.model_run_id, additional_effort)
  await context.model_run_store.appendLog(current_run.model_run_id, {
    stream: "system",
    message: `Added ${additional_effort}× effort without changing the workflow or benchmarks.\n`,
  })
  if (result.should_start) {
    const runner = context.run_model ?? runModel
    void runner({ model_run_id: current_run.model_run_id }, context)
  }
  return jsonResponse({ model_run: context.model_run_store.getModelRun(current_run.model_run_id) }, 202)
}
