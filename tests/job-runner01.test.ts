import { expect, test } from "bun:test"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildAgentPrompt, runJob } from "@/server/job-runner"
import { JobStore } from "@/server/job-store"

test("agent prompt requires an implemented and build-verified TSX component", () => {
  const prompt = buildAgentPrompt("Use the QFN package")
  expect(prompt).toContain("datasheet.pdf")
  expect(prompt).toContain("Replace index.circuit.tsx")
  expect(prompt).toContain("tsci build")
  expect(prompt).toContain("Use the QFN package")
})

test("cancelling a running job terminates its agent process", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-job-runner-cancel-"))
  const agent_path = join(job_dir, "slow-agent")
  await Bun.write(
    agent_path,
    `#!/usr/bin/env bun
console.log("slow agent started")
await Bun.sleep(30_000)
`,
  )
  await chmod(agent_path, 0o755)

  const job_store = new JobStore()
  job_store.createJob({ job_id: "job_cancel", job_dir, file_name: "sensor.pdf" })
  const run_promise = runJob(
    { job_id: "job_cancel" },
    { job_store, agent_bin: agent_path, tsci_bin: "unused-tsci" },
  )

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Agent did not start")), 2_000)
    const unsubscribe = job_store.subscribe("job_cancel", (job_event) => {
      if (job_event.event_type === "log" && job_event.log.message.includes("slow agent started")) {
        clearTimeout(timeout)
        unsubscribe?.()
        resolve()
      }
    })
  })

  expect(job_store.requestCancellation("job_cancel")).toBe("requested")
  await Promise.race([
    run_promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Cancellation timed out")), 4_000)),
  ])

  const job = job_store.getJob("job_cancel")
  expect(job?.display_status).toBe("cancelled")
  expect(job?.is_complete).toBe(true)
  expect(job?.has_errors).toBe(false)
  expect(job?.logs.at(-1)?.message).toContain("active job process was stopped")

  await rm(job_dir, { recursive: true, force: true })
})
