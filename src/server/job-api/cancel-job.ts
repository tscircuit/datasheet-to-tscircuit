import { JobApiContext } from "./job-api-context"
import { errorResponse, getJobId, jsonResponse } from "./job-api-responses"

export function cancelJob(request_url: URL, context: JobApiContext): Response {
  const job_id = getJobId(request_url)
  if (!job_id) {
    return errorResponse({ error_code: "job_id_required", message: "job_id is required.", status: 400 })
  }

  const cancellation_result = context.job_store.requestCancellation(job_id)
  if (cancellation_result === "not_found") {
    return errorResponse({
      error_code: "job_not_found",
      message: `No job exists for ${job_id}.`,
      status: 404,
    })
  }
  if (cancellation_result === "already_complete") {
    return errorResponse({
      error_code: "job_already_complete",
      message: "This job has already finished.",
      status: 409,
    })
  }

  const job = context.job_store.getJob(job_id)
  if (!job) {
    return errorResponse({
      error_code: "job_not_found",
      message: `No job exists for ${job_id}.`,
      status: 404,
    })
  }
  return jsonResponse({ job }, cancellation_result === "requested" ? 202 : 200)
}
