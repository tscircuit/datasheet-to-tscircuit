import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createJobApiHandler } from "@/server/job-api"
import { JobStore } from "@/server/job-store"

test("job create accepts a PDF and starts the injected background runner", async () => {
  const jobs_root = await mkdtemp(join(tmpdir(), "datasheet-job-api-"))
  const job_store = new JobStore()
  let started_job_id: string | undefined
  const handle = createJobApiHandler({
    jobs_root,
    job_store,
    agent_bin: "unused-agent",
    tsci_bin: "unused-tsci",
    run_job: async (input) => {
      started_job_id = input.job_id
    },
  })
  const form = new FormData()
  form.set("datasheet", new File(["%PDF-1.7\nfixture"], "sensor.pdf", { type: "application/pdf" }))

  const response = await handle(
    new Request("http://localhost/api/job/create", { method: "POST", body: form }),
  )
  const body = (await response?.json()) as { job: { job_id: string; file_name: string } }

  expect(response?.status).toBe(202)
  expect(body.job.file_name).toBe("sensor.pdf")
  expect(started_job_id).toBe(body.job.job_id)
  expect(await Bun.file(join(jobs_root, body.job.job_id, "datasheet.pdf")).exists()).toBe(true)

  await rm(jobs_root, { recursive: true, force: true })
})

test("job cancel requests cancellation without stopping the server", async () => {
  const jobs_root = await mkdtemp(join(tmpdir(), "datasheet-job-api-cancel-"))
  const job_store = new JobStore()
  const handle = createJobApiHandler({
    jobs_root,
    job_store,
    agent_bin: "unused-agent",
    tsci_bin: "unused-tsci",
  })
  job_store.createJob({ job_id: "job_cancel", job_dir: jobs_root, file_name: "sensor.pdf" })

  const response = await handle(
    new Request("http://localhost/api/job/cancel?job_id=job_cancel", { method: "POST" }),
  )
  const body = (await response?.json()) as { job: { display_status: string; is_complete: boolean } }

  expect(response?.status).toBe(202)
  expect(body.job.display_status).toBe("cancelling")
  expect(body.job.is_complete).toBe(false)
  expect(job_store.getCancellationSignal("job_cancel")?.aborted).toBe(true)

  await rm(jobs_root, { recursive: true, force: true })
})
