import { listModelPreviewOptions } from "../model-artifact-monitor"
import { ModelRunApiContext } from "./model-run-api-context"
import { errorResponse, getJobId, jsonResponse } from "./model-run-api-responses"

export async function getModelRun(request_url: URL, context: ModelRunApiContext): Promise<Response> {
  const job_id = getJobId(request_url)
  if (!job_id) {
    return errorResponse({ error_code: "job_id_required", message: "job_id is required.", status: 400 })
  }
  let model_run = context.model_run_store.getModelRunForJob(job_id)
  if (!model_run) {
    return errorResponse({
      error_code: "model_run_not_found",
      message: "This job has no SPICE model run.",
      status: 404,
    })
  }
  const model_dir = context.model_run_store.getModelDir(model_run.model_run_id)
  if (model_dir) {
    const preview_options = await listModelPreviewOptions(model_dir)
    if (JSON.stringify(preview_options) !== JSON.stringify(model_run.preview_options)) {
      model_run = context.model_run_store.updatePreviewOptions(model_run.model_run_id, preview_options)
    }
  }
  return jsonResponse({ model_run })
}
