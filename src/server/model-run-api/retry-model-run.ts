import { runModel } from "../model-runner"
import { ModelRunApiContext } from "./model-run-api-context"
import { errorResponse, getJobId, jsonResponse } from "./model-run-api-responses"
import { getModelRun } from "./get-model-run"

export async function retryModelRun(request_url: URL, context: ModelRunApiContext): Promise<Response> {
  const job_id = getJobId(request_url)
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
  const result = context.model_run_store.retryModelRun(current_run.model_run_id)
  if (result !== "retried") {
    return errorResponse({
      error_code: "model_run_not_failed",
      message: "Only a failed SPICE model run can be retried.",
      status: 409,
    })
  }
  await context.model_run_store.appendLog(current_run.model_run_id, {
    stream: "system",
    message: "Retrying the failed run from its preserved evidence and best model checkpoint.\n",
  })
  const runner = context.run_model ?? runModel
  void runner({ model_run_id: current_run.model_run_id }, context)
  return jsonResponse({ model_run: context.model_run_store.getModelRun(current_run.model_run_id) }, 202)
}
