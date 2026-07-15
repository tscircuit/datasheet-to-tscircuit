import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { JobStore } from "@/server/job-store"

test("JobStore streams updates and persists every log chunk", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-job-store-"))
  const job_store = new JobStore()
  const event_types: string[] = []
  job_store.createJob({ job_id: "job_1", job_dir, file_name: "sensor.pdf" })
  const unsubscribe = job_store.subscribe("job_1", (job_event) => event_types.push(job_event.event_type))

  await job_store.appendLog("job_1", "stderr", "[tool] read datasheet.pdf\n")
  job_store.updateJob("job_1", { display_status: "building" })

  expect(event_types).toEqual(["log", "job_updated"])
  expect(job_store.getJob("job_1")?.logs).toHaveLength(1)
  expect(await readFile(join(job_dir, "agent.log"), "utf8")).toContain("[tool] read datasheet.pdf")

  unsubscribe?.()
  await rm(job_dir, { recursive: true, force: true })
})

test("JobStore cancellation aborts an active job and publishes the stopping state", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-job-cancel-"))
  const job_store = new JobStore()
  const statuses: string[] = []
  job_store.createJob({ job_id: "job_cancel", job_dir, file_name: "sensor.pdf" })
  job_store.subscribe("job_cancel", (job_event) => {
    if (job_event.event_type === "job_updated") statuses.push(job_event.job.display_status)
  })

  expect(job_store.requestCancellation("job_cancel")).toBe("requested")
  expect(job_store.getCancellationSignal("job_cancel")?.aborted).toBe(true)
  expect(job_store.getJob("job_cancel")?.display_status).toBe("cancelling")
  expect(statuses).toEqual(["cancelling"])
  expect(job_store.requestCancellation("job_cancel")).toBe("already_requested")

  await rm(job_dir, { recursive: true, force: true })
})
