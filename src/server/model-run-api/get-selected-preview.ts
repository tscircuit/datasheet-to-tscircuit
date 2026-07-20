import { loadModelSelectedPreview } from "../model-artifact-monitor"
import { ModelRunApiContext } from "./model-run-api-context"
import { errorResponse, getJobId, jsonResponse } from "./model-run-api-responses"

export async function getSelectedPreview(request_url: URL, context: ModelRunApiContext): Promise<Response> {
  const job_id = getJobId(request_url)
  if (!job_id) {
    return errorResponse({ error_code: "job_id_required", message: "job_id is required.", status: 400 })
  }
  const benchmark_id = request_url.searchParams.get("benchmark_id")?.trim()
  if (!benchmark_id) {
    return errorResponse({
      error_code: "benchmark_id_required",
      message: "benchmark_id is required.",
      status: 400,
    })
  }
  const model_run_id = context.model_run_store.getModelRunIdForJob(job_id)
  const model_dir = model_run_id ? context.model_run_store.getModelDir(model_run_id) : undefined
  if (!model_run_id || !model_dir) {
    return errorResponse({
      error_code: "model_run_not_found",
      message: "This job has no SPICE model run.",
      status: 404,
    })
  }
  const preview = await loadModelSelectedPreview({
    model_dir,
    benchmark_id,
  })
  return preview
    ? jsonResponse(preview)
    : errorResponse({
        error_code: "preview_not_found",
        message: `No benchmark circuit exists for ${benchmark_id}.`,
        status: 404,
      })
}
