import { expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildCircuitArtifact } from "@/server/job-runner/build-circuit-artifact"

test("a final build never restores visual files from an earlier build", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-artifact-freshness-"))
  const output_directory = join(job_dir, "dist", "index")
  const tsci_bin = join(job_dir, "fake-tsci")
  try {
    await mkdir(output_directory, { recursive: true })
    await Promise.all([
      Bun.write(join(output_directory, "pcb.png"), "stale pcb"),
      Bun.write(join(output_directory, "schematic.svg"), "<svg>stale schematic</svg>"),
      Bun.write(join(output_directory, "schematic.png"), "stale schematic"),
      Bun.write(join(job_dir, "index.circuit.tsx"), "export default () => <board />\n"),
      Bun.write(
        tsci_bin,
        `#!/usr/bin/env bun
import { mkdir } from "node:fs/promises"
const output = process.cwd() + "/dist/index"
await mkdir(output, { recursive: true })
await Bun.write(output + "/circuit.json", "[]")
`,
      ),
    ])
    await chmod(tsci_bin, 0o755)

    const result = await buildCircuitArtifact({
      source_file: "index.circuit.tsx",
      output_stem: "index",
      job_dir,
      tsci_bin,
      signal: new AbortController().signal,
      append: async () => undefined,
      render_outputs: true,
    })

    expect(result.errors).toContain("final PCB PNG was not produced")
    expect(result.errors).toContain("final schematic PNG was not produced")
    expect(await Bun.file(join(output_directory, "pcb.png")).exists()).toBe(false)
    expect(await Bun.file(join(output_directory, "schematic.svg")).exists()).toBe(false)
    expect(await Bun.file(join(output_directory, "schematic.png")).exists()).toBe(false)
  } finally {
    await rm(job_dir, { recursive: true, force: true })
  }
})

test("a schematic-only build disables PCB output without treating its absence as an error", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-artifact-schematic-only-"))
  const tsci_bin = join(job_dir, "fake-tsci")
  try {
    await Promise.all([
      Bun.write(join(job_dir, "typical-application.circuit.tsx"), "export default () => <board />\n"),
      Bun.write(
        tsci_bin,
        `#!/usr/bin/env bun
import { mkdir } from "node:fs/promises"
const output = process.cwd() + "/dist/typical-application"
await mkdir(output, { recursive: true })
await Bun.write(process.cwd() + "/tsci-args.json", JSON.stringify(process.argv.slice(2)))
await Bun.write(output + "/circuit.json", "[]")
await Bun.write(output + "/schematic.png", "server schematic")
`,
      ),
    ])
    await chmod(tsci_bin, 0o755)

    const result = await buildCircuitArtifact({
      source_file: "typical-application.circuit.tsx",
      output_stem: "typical-application",
      job_dir,
      tsci_bin,
      signal: new AbortController().signal,
      append: async () => undefined,
      render_outputs: true,
      pcb_disabled: true,
    })

    expect(result.errors).toEqual([])
    expect(JSON.parse(await Bun.file(join(job_dir, "tsci-args.json")).text())).toContain("--disable-pcb")
    expect(await Bun.file(join(job_dir, "dist/typical-application/pcb.png")).exists()).toBe(false)
  } finally {
    await rm(job_dir, { recursive: true, force: true })
  }
})

test("a required server-owned netlist check blocks an otherwise successful build", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-artifact-netlist-check-"))
  const tsci_bin = join(job_dir, "fake-tsci")
  try {
    await Promise.all([
      Bun.write(join(job_dir, "index.circuit.tsx"), "export default () => <board />\n"),
      Bun.write(
        tsci_bin,
        `#!/usr/bin/env bun
import { mkdir } from "node:fs/promises"
const args = Bun.argv.slice(2)
if (args[0] === "check" && args[1] === "netlist") process.exit(7)
await mkdir(process.cwd() + "/dist/index", { recursive: true })
await Bun.write(process.cwd() + "/dist/index/circuit.json", "[]")
`,
      ),
    ])
    await chmod(tsci_bin, 0o755)

    const result = await buildCircuitArtifact({
      source_file: "index.circuit.tsx",
      output_stem: "index",
      job_dir,
      tsci_bin,
      signal: new AbortController().signal,
      append: async () => undefined,
      required_checks: ["netlist"],
    })

    expect(result.errors).toContain("tsci check netlist exited with code 7")
  } finally {
    await rm(job_dir, { recursive: true, force: true })
  }
})
