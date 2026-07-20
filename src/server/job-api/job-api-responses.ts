import type { ApiError } from "@/shared/job-types"

export function jsonResponse(body: object, status = 200): Response {
  return Response.json(body, { status })
}

type ErrorResponseInput = ApiError["error"] & { status: number }

export function errorResponse({ error_code, message, status }: ErrorResponseInput): Response {
  const api_error: ApiError = { error: { error_code, message } }
  return jsonResponse(api_error, status)
}

export function getJobId(request_url: URL): string | undefined {
  return request_url.searchParams.get("job_id")?.trim() || undefined
}
