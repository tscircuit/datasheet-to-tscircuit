import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeJobScaffold } from "@/server/job-scaffold"
import { getPinnedTscircuitVersion } from "@/server/runtime-versions"

test("job scaffold is package-neutral and pins its tscircuit runtime", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-job-scaffold-"))
  await writeJobScaffold(job_dir)

  const component = await Bun.file(join(job_dir, "index.circuit.tsx")).text()
  const instructions = await Bun.file(join(job_dir, "AGENTS.md")).text()
  const package_json = JSON.parse(await Bun.file(join(job_dir, "package.json")).text())
  expect(component).not.toContain("soic")
  expect(component).not.toContain("pinLabels")
  expect(component).toContain("PENDING_APPROVED_EVIDENCE")
  expect(package_json.devDependencies.tscircuit).toBe("0.0.2075")
  expect(package_json.devDependencies.tscircuit).toBe(await getPinnedTscircuitVersion())
  expect(instructions).toContain("three strictly separated phases")
  expect(instructions).toContain('availability: "not_present"')
  expect(instructions).toContain("Do not instantiate a standalone netlabel")
  expect(instructions).toContain("schDisplayLabel")

  await rm(job_dir, { recursive: true, force: true })
})
