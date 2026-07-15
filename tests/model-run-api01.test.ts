import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { JobStore } from "@/server/job-store"
import { createModelRunApiHandler } from "@/server/model-run-api"
import { ModelRunStore } from "@/server/model-run-store"

test("model API starts and extends the same fixed run using time-only effort", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-model-api-"))
  const job_store = new JobStore()
  const model_run_store = new ModelRunStore()
  job_store.createJob({ job_id: "job_1", job_dir, file_name: "sensor.pdf" })
  job_store.updateJob("job_1", { display_status: "agent_running", is_complete: false })
  const started_run_ids: string[] = []
  const handle = createModelRunApiHandler({
    job_store,
    model_run_store,
    agent_bin: "unused-agent",
    tsci_bin: "unused-tsci",
    model_base_effort_ms: 1_000,
    run_model: async ({ model_run_id }) => {
      started_run_ids.push(model_run_id)
    },
  })

  const create_response = await handle(
    new Request("http://localhost/api/model-run/create?job_id=job_1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ effort_multiplier: 2 }),
    }),
  )
  const created = (await create_response?.json()) as { model_run: { model_run_id: string } }
  const extend_response = await handle(
    new Request("http://localhost/api/model-run/extend?job_id=job_1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ additional_effort: 1 }),
    }),
  )
  const extended = (await extend_response?.json()) as {
    model_run: { model_run_id: string; effort_multiplier: number; allocated_time_ms: number }
  }

  expect(create_response?.status).toBe(202)
  expect(extend_response?.status).toBe(202)
  expect(extended.model_run.model_run_id).toBe(created.model_run.model_run_id)
  expect(extended.model_run.effort_multiplier).toBe(3)
  expect(extended.model_run.allocated_time_ms).toBe(3_000)
  expect(started_run_ids).toEqual([created.model_run.model_run_id])

  model_run_store.updateModelRun(created.model_run.model_run_id, {
    status: "failed",
    is_complete: true,
    has_errors: true,
    error_message: "fixture failure",
  })
  const retry_response = await handle(
    new Request("http://localhost/api/model-run/retry?job_id=job_1", { method: "POST" }),
  )
  const retried = (await retry_response?.json()) as {
    model_run: { model_run_id: string; status: string; effort_multiplier: number }
  }
  expect(retry_response?.status).toBe(202)
  expect(retried.model_run.model_run_id).toBe(created.model_run.model_run_id)
  expect(retried.model_run.status).toBe("queued")
  expect(retried.model_run.effort_multiplier).toBe(3)
  expect(started_run_ids).toEqual([created.model_run.model_run_id, created.model_run.model_run_id])

  await rm(job_dir, { recursive: true, force: true })
})
