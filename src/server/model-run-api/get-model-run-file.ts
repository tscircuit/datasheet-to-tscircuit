import { join } from "node:path"
import { ModelRunApiContext } from "./model-run-api-context"
import { errorResponse, getJobId } from "./model-run-api-responses"

export function getModelRunFile(request_url: URL, context: ModelRunApiContext): Response {
  const job_id = getJobId(request_url)
  if (!job_id) {
    return errorResponse({ error_code: "job_id_required", message: "job_id is required.", status: 400 })
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
  const file_kind = request_url.searchParams.get("file")
  const files: Record<string, { name: string; content_type: string }> = {
    model: { name: "model.lib", content_type: "text/plain; charset=utf-8" },
    manifest: { name: "model-manifest.json", content_type: "application/json" },
    report: { name: "validation-report.json", content_type: "application/json" },
    simulation_report: { name: "simulation-validation.json", content_type: "application/json" },
    model_card: { name: "model-card.md", content_type: "text/markdown; charset=utf-8" },
    component: { name: "component-with-model.circuit.tsx", content_type: "text/typescript; charset=utf-8" },
    log: { name: "model-agent.log", content_type: "text/plain; charset=utf-8" },
  }
  const selected = file_kind ? files[file_kind] : undefined
  if (!selected) {
    return errorResponse({ error_code: "invalid_file", message: "Unknown SPICE model file.", status: 400 })
  }
  const file = Bun.file(join(model_dir, selected.name))
  if (file.size === 0) {
    return errorResponse({
      error_code: "file_not_ready",
      message: `${selected.name} is not ready.`,
      status: 404,
    })
  }
  return new Response(file, {
    headers: {
      "Content-Disposition": `attachment; filename="${selected.name}"`,
      "Content-Type": selected.content_type,
    },
  })
}
