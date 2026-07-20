import { copyFile, mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import type { ApiError, Job, JobEvent, JobListEvent } from "@/shared/job-types"
import { writeJobScaffold } from "./job-scaffold"
import { runJob, type JobRunnerContext } from "./job-runner"
import type { JobStore } from "./job-store"
import { launchModelRun } from "./model-run-api"
import { runModel } from "./model-runner"
import type { ModelRunStore } from "./model-run-store"

const MAX_PDF_BYTES = 30 * 1024 * 1024

export interface JobApiContext extends JobRunnerContext {
  jobs_root: string
  run_job?: typeof runJob
  model_run_store?: ModelRunStore
  run_model?: typeof runModel
  model_base_effort_ms?: number
}

function jsonResponse(body: object, status = 200): Response {
  return Response.json(body, { status })
}

function errorResponse(error_code: string, message: string, status: number): Response {
  const api_error: ApiError = { error: { error_code, message } }
  return jsonResponse(api_error, status)
}

async function recordUnexpectedRunnerFailure(
  job_id: string,
  error: unknown,
  job_store: JobStore,
): Promise<void> {
  try {
    const job = job_store.getJob(job_id)
    if (!job || job.is_complete) return
    const detail = error instanceof Error ? error.message : String(error)
    await job_store
      .appendLog(job_id, "system", `\nConversion stopped after an unexpected runner failure: ${detail}\n`)
      .catch(() => undefined)
    job_store.updateJob(job_id, {
      display_status: "failed",
      is_complete: true,
      has_errors: true,
      completed_at: new Date().toISOString(),
      error_message: detail,
    })
  } catch {
    // This is the final background-task boundary. Never leak a rejected runner promise.
  }
}

function launchJobRunner(input: Parameters<typeof runJob>[0], context: JobApiContext): void {
  const runner = context.run_job ?? runJob
  try {
    void runner(input, context).catch((error) =>
      recordUnexpectedRunnerFailure(input.job_id, error, context.job_store),
    )
  } catch (error) {
    void recordUnexpectedRunnerFailure(input.job_id, error, context.job_store)
  }
}

function getJobId(request_url: URL): string | undefined {
  return request_url.searchParams.get("job_id")?.trim() || undefined
}

export function validatePdf(file: File, pdf_bytes: Uint8Array): string | undefined {
  if (file.size === 0) return "The selected PDF is empty."
  if (file.size > MAX_PDF_BYTES) return "Datasheets must be 30 MB or smaller."
  if (!file.name.toLowerCase().endsWith(".pdf")) return "Upload a PDF datasheet."
  if (new TextDecoder().decode(pdf_bytes.slice(0, 5)) !== "%PDF-")
    return "The selected file is not a valid PDF."
  return undefined
}

function createEventStream(job_id: string, job_store: JobStore): Response {
  const encoder = new TextEncoder()
  let unsubscribe: (() => void) | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (job_event: JobEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(job_event)}\n\n`))
        } catch {
          unsubscribe?.()
          if (heartbeat) clearInterval(heartbeat)
        }
      }

      const job = job_store.getJob(job_id)
      if (job) send({ event_type: "snapshot", job })
      unsubscribe = job_store.subscribe(job_id, send)
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keep-alive\n\n"))
        } catch {
          unsubscribe?.()
          if (heartbeat) clearInterval(heartbeat)
        }
      }, 15_000)
    },
    cancel() {
      unsubscribe?.()
      if (heartbeat) clearInterval(heartbeat)
    },
  })

  return new Response(body, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no",
    },
  })
}

function createJobListEventStream(job_store: JobStore): Response {
  const encoder = new TextEncoder()
  let unsubscribe: (() => void) | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (job_event: JobListEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(job_event)}\n\n`))
        } catch {
          unsubscribe?.()
          if (heartbeat) clearInterval(heartbeat)
        }
      }

      send({ event_type: "jobs_snapshot", jobs: job_store.listJobs() })
      unsubscribe = job_store.subscribeToJobList(send)
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keep-alive\n\n"))
        } catch {
          unsubscribe?.()
          if (heartbeat) clearInterval(heartbeat)
        }
      }, 15_000)
    },
    cancel() {
      unsubscribe?.()
      if (heartbeat) clearInterval(heartbeat)
    },
  })

  return new Response(body, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no",
    },
  })
}

async function createJobFromRequest(request: Request, context: JobApiContext): Promise<Response> {
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return errorResponse("invalid_form", "Expected a multipart form upload.", 400)
  }

  const datasheet = form.get("datasheet")
  if (!(datasheet instanceof File)) {
    return errorResponse("datasheet_required", "Select a PDF datasheet to continue.", 400)
  }

  const pdf_bytes = new Uint8Array(await datasheet.arrayBuffer())
  const validation_message = validatePdf(datasheet, pdf_bytes)
  if (validation_message) return errorResponse("invalid_datasheet", validation_message, 400)

  const create_pspice_model = form.get("create_pspice_model") === "true"
  const effort_value = Number(form.get("model_effort_multiplier") ?? 1)
  const model_effort_multiplier =
    Number.isInteger(effort_value) && effort_value >= 1 && effort_value <= 8 ? effort_value : undefined
  if (create_pspice_model && !model_effort_multiplier) {
    return errorResponse(
      "invalid_model_effort",
      "model_effort_multiplier must be an integer from 1 through 8.",
      400,
    )
  }
  if (create_pspice_model && !context.model_run_store) {
    return errorResponse("model_runner_unavailable", "SPICE model generation is unavailable.", 503)
  }

  const job_id = crypto.randomUUID()
  const job_dir = join(context.jobs_root, job_id)
  await mkdir(job_dir, { recursive: true })
  await writeJobScaffold(job_dir)
  await Bun.write(join(job_dir, "datasheet.pdf"), pdf_bytes)

  const additional_instructions_value = form.get("additional_instructions")
  const additional_instructions =
    typeof additional_instructions_value === "string"
      ? additional_instructions_value.trim().slice(0, 4_000) || undefined
      : undefined
  const job = context.job_store.createJob({
    job_id,
    job_dir,
    file_name: datasheet.name,
    additional_instructions,
  })
  await context.job_store.appendLog(
    job_id,
    "system",
    `Uploaded ${datasheet.name} (${datasheet.size} bytes).\n`,
  )

  let model_run
  if (create_pspice_model) {
    model_run = await launchModelRun(
      { job_id, job_dir, effort_multiplier: model_effort_multiplier! },
      { ...context, model_run_store: context.model_run_store! },
    )
  }

  launchJobRunner({ job_id, additional_instructions }, context)

  return jsonResponse({ job, model_run }, 202)
}

async function retryJob(
  request_url: URL,
  context: JobApiContext,
  pending_retries: Map<string, Promise<Job>>,
): Promise<Response> {
  const source_job_id = getJobId(request_url)
  if (!source_job_id) return errorResponse("job_id_required", "job_id is required.", 400)

  const source = context.job_store.getJobRetrySource(source_job_id)
  if (!source) return errorResponse("job_not_found", `No job exists for ${source_job_id}.`, 404)
  if (
    source.display_status !== "cancelled" &&
    source.display_status !== "unsupported" &&
    source.display_status !== "failed"
  ) {
    return errorResponse("job_not_retryable", "Only stopped or unsuccessful tasks can be retried.", 409)
  }

  const active_retry = context.job_store.getActiveRetryForSource(source_job_id)
  if (active_retry) return jsonResponse({ job: active_retry }, 202)

  let pending_retry = pending_retries.get(source_job_id)
  if (!pending_retry) {
    pending_retry = (async () => {
      const existing_retry = context.job_store.getActiveRetryForSource(source_job_id)
      if (existing_retry) return existing_retry

      const job_id = crypto.randomUUID()
      const job_dir = join(context.jobs_root, job_id)
      await mkdir(job_dir, { recursive: true })
      await writeJobScaffold(job_dir)
      await copyFile(join(source.job_dir, "datasheet.pdf"), join(job_dir, "datasheet.pdf"))

      const job = context.job_store.createJob({
        job_id,
        job_dir,
        file_name: source.file_name,
        additional_instructions: source.additional_instructions,
        retry_source_job_id: source_job_id,
      })
      await context.job_store.appendLog(
        job_id,
        "system",
        `Retrying ${source.display_status} task ${source_job_id}.\n`,
      )

      launchJobRunner({ job_id, additional_instructions: source.additional_instructions }, context)
      return job
    })()
    pending_retries.set(source_job_id, pending_retry)
  }

  try {
    return jsonResponse({ job: await pending_retry }, 202)
  } finally {
    if (pending_retries.get(source_job_id) === pending_retry) {
      pending_retries.delete(source_job_id)
    }
  }
}

function waitForJobCompletion(job_id: string, job_store: JobStore, timeout_ms = 5_000): Promise<boolean> {
  if (job_store.getJob(job_id)?.is_complete) return Promise.resolve(true)

  return new Promise((resolve) => {
    let unsubscribe: (() => void) | undefined
    const finish = (is_complete: boolean) => {
      clearTimeout(timeout)
      unsubscribe?.()
      resolve(is_complete)
    }
    const timeout = setTimeout(() => finish(false), timeout_ms)
    unsubscribe = job_store.subscribe(job_id, (job_event) => {
      if (job_event.event_type !== "log" && job_event.job.is_complete) finish(true)
    })
    if (!unsubscribe) finish(false)
  })
}

function waitForModelRunCompletion(
  model_run_id: string,
  model_run_store: ModelRunStore,
  timeout_ms = 5_000,
): Promise<boolean> {
  if (model_run_store.getModelRun(model_run_id)?.is_complete) return Promise.resolve(true)

  return new Promise((resolve) => {
    let unsubscribe: (() => void) | undefined
    const finish = (is_complete: boolean) => {
      clearTimeout(timeout)
      unsubscribe?.()
      resolve(is_complete)
    }
    const timeout = setTimeout(() => finish(false), timeout_ms)
    unsubscribe = model_run_store.subscribe(model_run_id, (event) => {
      if (event.event_type !== "log" && event.model_run.is_complete) finish(true)
    })
    if (!unsubscribe) finish(false)
  })
}

async function deleteJob(request_url: URL, context: JobApiContext): Promise<Response> {
  const job_id = getJobId(request_url)
  if (!job_id) return errorResponse("job_id_required", "job_id is required.", 400)

  const job_dir = context.job_store.getJobDir(job_id)
  const job = context.job_store.getJob(job_id)
  if (!job_dir || !job) return errorResponse("job_not_found", `No job exists for ${job_id}.`, 404)

  const model_run = context.model_run_store?.getModelRunForJob(job_id)
  if (model_run && !model_run.is_complete) {
    context.model_run_store?.requestCancellation(model_run.model_run_id)
    if (!(await waitForModelRunCompletion(model_run.model_run_id, context.model_run_store!))) {
      return errorResponse("model_stop_timeout", "The SPICE model run could not be stopped.", 409)
    }
  }

  if (!job.is_complete) {
    context.job_store.requestCancellation(job_id)
    if (!(await waitForJobCompletion(job_id, context.job_store))) {
      return errorResponse("job_stop_timeout", "The task could not be stopped before deletion.", 409)
    }
  }

  if (!context.job_store.deleteJob(job_id)) {
    return errorResponse("job_delete_conflict", "The task is still active and cannot be deleted.", 409)
  }
  context.model_run_store?.deleteModelRunForJob(job_id)
  await rm(job_dir, { recursive: true, force: true })
  return new Response(null, { status: 204 })
}

function cancelJob(request_url: URL, context: JobApiContext): Response {
  const job_id = getJobId(request_url)
  if (!job_id) return errorResponse("job_id_required", "job_id is required.", 400)

  const cancellation_result = context.job_store.requestCancellation(job_id)
  if (cancellation_result === "not_found") {
    return errorResponse("job_not_found", `No job exists for ${job_id}.`, 404)
  }
  if (cancellation_result === "already_complete") {
    return errorResponse("job_already_complete", "This job has already finished.", 409)
  }

  const job = context.job_store.getJob(job_id)
  if (!job) return errorResponse("job_not_found", `No job exists for ${job_id}.`, 404)
  return jsonResponse({ job }, cancellation_result === "requested" ? 202 : 200)
}

function getJobFile(request_url: URL, context: JobApiContext): Response {
  const job_id = getJobId(request_url)
  const file_kind = request_url.searchParams.get("file")
  if (!job_id) return errorResponse("job_id_required", "job_id is required.", 400)
  const job_dir = context.job_store.getJobDir(job_id)
  if (!job_dir) return errorResponse("job_not_found", `No job exists for ${job_id}.`, 404)

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
  if (!requested_file) return errorResponse("invalid_file", "Unknown job artifact.", 400)
  const [relative_path, download_name, content_type] = requested_file
  const artifact = Bun.file(join(job_dir, relative_path))
  if (artifact.size === 0) return errorResponse("file_not_found", `${download_name} is not available.`, 404)
  return new Response(artifact, {
    headers: {
      "Content-Disposition": `attachment; filename="${download_name}"`,
      "Content-Type": content_type,
    },
  })
}

export function createJobApiHandler(context: JobApiContext) {
  const pending_retries = new Map<string, Promise<Job>>()
  return async (request: Request): Promise<Response | undefined> => {
    const request_url = new URL(request.url)
    if (!request_url.pathname.startsWith("/api/")) return undefined

    if (request.method === "OPTIONS") return new Response(null, { status: 204 })
    if (request_url.pathname === "/api/job/create" && request.method === "POST") {
      return createJobFromRequest(request, context)
    }
    if (request_url.pathname === "/api/jobs" && request.method === "GET") {
      return jsonResponse({ jobs: context.job_store.listJobs() })
    }
    if (request_url.pathname === "/api/jobs/events" && request.method === "GET") {
      return createJobListEventStream(context.job_store)
    }
    if (request_url.pathname === "/api/job/cancel" && request.method === "POST") {
      return cancelJob(request_url, context)
    }
    if (request_url.pathname === "/api/job/retry" && request.method === "POST") {
      return retryJob(request_url, context, pending_retries)
    }
    if (request_url.pathname === "/api/job/delete" && request.method === "DELETE") {
      return deleteJob(request_url, context)
    }
    if (request_url.pathname === "/api/job/get" && request.method === "GET") {
      const job_id = getJobId(request_url)
      if (!job_id) return errorResponse("job_id_required", "job_id is required.", 400)
      const job = context.job_store.getJob(job_id)
      return job ? jsonResponse({ job }) : errorResponse("job_not_found", `No job exists for ${job_id}.`, 404)
    }
    if (request_url.pathname === "/api/job/events" && request.method === "GET") {
      const job_id = getJobId(request_url)
      if (!job_id) return errorResponse("job_id_required", "job_id is required.", 400)
      if (!context.job_store.getJob(job_id)) {
        return errorResponse("job_not_found", `No job exists for ${job_id}.`, 404)
      }
      return createEventStream(job_id, context.job_store)
    }
    if (request_url.pathname === "/api/job/file" && request.method === "GET") {
      return getJobFile(request_url, context)
    }
    return errorResponse("route_not_found", "API route not found.", 404)
  }
}
