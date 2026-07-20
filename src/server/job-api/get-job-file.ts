import { join } from "node:path"
import { JobApiContext } from "./job-api-context"
import { errorResponse, getJobId } from "./job-api-responses"

export function getJobFile(request_url: URL, context: JobApiContext): Response {
  const job_id = getJobId(request_url)
  const file_kind = request_url.searchParams.get("file")
  if (!job_id) {
    return errorResponse({ error_code: "job_id_required", message: "job_id is required.", status: 400 })
  }
  const job_dir = context.job_store.getJobDir(job_id)
  if (!job_dir) {
    return errorResponse({
      error_code: "job_not_found",
      message: `No job exists for ${job_id}.`,
      status: 404,
    })
  }

  const files = {
    component: ["index.circuit.tsx", "index.circuit.tsx", "text/typescript; charset=utf-8"],
    typical_application: [
      "typical-application.circuit.tsx",
      "typical-application.circuit.tsx",
      "text/typescript; charset=utf-8",
    ],
    log: ["agent.log", "agent.log", "text/plain; charset=utf-8"],
    component_evidence: [
      "component-evidence.json",
      "component-evidence.json",
      "application/json; charset=utf-8",
    ],
    footprint_plan: ["footprint-plan.json", "footprint-plan.json", "application/json; charset=utf-8"],
    application_plan: [
      "typical-application-plan.json",
      "typical-application-plan.json",
      "application/json; charset=utf-8",
    ],
    land_pattern: ["visual-reference/land-pattern.png", "land-pattern.png", "image/png"],
    application_reference: [
      "visual-reference/typical-application.png",
      "typical-application.png",
      "image/png",
    ],
    events: ["agent-events.jsonl", "agent-events.jsonl", "application/x-ndjson; charset=utf-8"],
  } as const
  const requested_file = file_kind && file_kind in files ? files[file_kind as keyof typeof files] : undefined
  if (!requested_file) {
    return errorResponse({ error_code: "invalid_file", message: "Unknown job artifact.", status: 400 })
  }
  const [relative_path, download_name, content_type] = requested_file
  const artifact = Bun.file(join(job_dir, relative_path))
  if (artifact.size === 0) {
    return errorResponse({
      error_code: "file_not_found",
      message: `${download_name} is not available.`,
      status: 404,
    })
  }
  return new Response(artifact, {
    headers: {
      "Content-Disposition": `attachment; filename="${download_name}"`,
      "Content-Type": content_type,
    },
  })
}
