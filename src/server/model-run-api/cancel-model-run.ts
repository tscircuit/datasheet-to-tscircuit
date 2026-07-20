import { ModelRunApiContext } from "./model-run-api-context"
import { errorResponse, getJobId, jsonResponse } from "./model-run-api-responses"
import { getModelRun } from "./get-model-run"

export function cancelModelRun(request_url: URL, context: ModelRunApiContext): Response {
  const job_id = getJobId(request_url)
  if (!job_id) {
    return errorResponse({ error_code: "job_id_required", message: "job_id is required.", status: 400 })
  }
  const model_run = context.model_run_store.getModelRunForJob(job_id)
  if (!model_run) {
    return errorResponse({
      error_code: "model_run_not_found",
      message: "This job has no SPICE model run.",
      status: 404,
    })
  }
  const result = context.model_run_store.requestCancellation(model_run.model_run_id)
  if (result === "already_complete") {
    return errorResponse({
      error_code: "model_run_complete",
      message: "This SPICE model run has already finished.",
      status: 409,
    })
  }
  return jsonResponse(
    { model_run: context.model_run_store.getModelRun(model_run.model_run_id) },
    result === "requested" ? 202 : 200,
  )
}
