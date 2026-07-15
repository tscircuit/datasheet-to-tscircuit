import { expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadModelSelectedPreview, startModelArtifactMonitor } from "@/server/model-artifact-monitor"
import { ModelRunStore } from "@/server/model-run-store"
import {
  verifySimulationBenchmark,
  writeSimulationValidationReport,
} from "@/server/model-simulation-validator"

test("model artifact monitor streams source, runframe data, and reference curves", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-model-artifacts-"))
  const model_dir = join(job_dir, "spice")
  const benchmark_dir = join(model_dir, "benchmarks")
  const evidence_dir = join(model_dir, "evidence", "curves")
  const result_dir = join(model_dir, "results", "champion")
  const tsci_path = join(job_dir, "fake-preview-tsci")
  await Promise.all([
    mkdir(benchmark_dir, { recursive: true }),
    mkdir(evidence_dir, { recursive: true }),
    mkdir(result_dir, { recursive: true }),
  ])
  await Promise.all([
    Bun.write(join(benchmark_dir, "transfer.circuit.tsx"), "export default () => <board />\n"),
    Bun.write(join(benchmark_dir, "output.circuit.tsx"), "export default () => <board />\n"),
    Bun.write(join(evidence_dir, "transfer.csv"), "x,y\n0,0\n1,1\n"),
    Bun.write(join(evidence_dir, "output.csv"), "x,y\n0,1\n1,2\n"),
    Bun.write(join(result_dir, "transfer.csv"), "x,y\n0,0\n1,0.9\n"),
    Bun.write(join(result_dir, "output.csv"), "x,y\n0,1.1\n1,2.1\n"),
    Bun.write(
      join(model_dir, "benchmarks.json"),
      JSON.stringify({
        version: 1,
        locked_at: new Date().toISOString(),
        benchmarks: [
          {
            id: "transfer",
            title: "Transfer curve",
            source: { page: 3 },
            critical: true,
            weight: 1,
            tolerance: 0.1,
            x_scale: "linear",
            y_scale: "linear",
            reference_file: "evidence/curves/transfer.csv",
            result_file: "results/champion/transfer.csv",
            simulation: { kind: "transient_voltage", probe_name: "RESULT" },
          },
          {
            id: "output",
            title: "Output response",
            source: { page: 4 },
            critical: false,
            weight: 1,
            tolerance: 0.1,
            x_scale: "linear",
            y_scale: "linear",
            reference_file: "evidence/curves/output.csv",
            result_file: "results/champion/output.csv",
            simulation: { kind: "transient_voltage", probe_name: "RESULT" },
          },
        ],
      }),
    ),
    Bun.write(
      tsci_path,
      `#!/usr/bin/env bun
import { mkdir } from "node:fs/promises"
import { basename, join } from "node:path"
const sourcePath = Bun.argv[3]
const benchmark = basename(sourcePath, ".circuit.tsx")
const output = join(${JSON.stringify(join(job_dir, "dist", "spice", "benchmarks"))}, benchmark)
await mkdir(output, { recursive: true })
const voltageLevels = benchmark === "output" ? [1.1, 2.1] : [0, 0.9]
const modelRevision = await Bun.file(join(process.cwd(), "model.lib")).text().catch(() => "")
await Bun.write(output + "/circuit.json", JSON.stringify([{ type: "source_component", source_component_id: modelRevision ? benchmark + "-" + modelRevision : benchmark }, { type: "simulation_transient_voltage_graph", name: "RESULT", timestamps_ms: [0, 1], voltage_levels: voltageLevels }]))
`,
    ),
  ])
  await chmod(tsci_path, 0o755)

  const store = new ModelRunStore()
  store.createModelRun({
    model_run_id: "model_1",
    job_id: "job_1",
    model_dir,
    effort_multiplier: 1,
    base_effort_ms: 1_000,
  })
  store.updateProgress("model_1", {
    sequence: 1,
    phase: "simulating",
    message: "Running transfer",
    updated_at: new Date().toISOString(),
    benchmark: { current: "transfer", completed: 0, total: 1 },
  })
  const monitor = startModelArtifactMonitor({
    model_run_id: "model_1",
    model_dir,
    model_run_store: store,
    tsci_bin: tsci_path,
    interval_ms: 20,
  })

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Live preview did not build")), 3_000)
    const unsubscribe = store.subscribe("model_1", (event) => {
      if (event.event_type !== "log" && event.model_run.circuit_preview?.build_status === "ready") {
        clearTimeout(timeout)
        unsubscribe?.()
        resolve()
      }
    })
  })
  const transfer_verification = await verifySimulationBenchmark({
    model_dir,
    benchmark_id: "transfer",
  })
  await writeSimulationValidationReport(model_dir, [transfer_verification])
  await monitor.sync()
  const model_run = store.getModelRun("model_1")
  expect(model_run?.circuit_preview?.source_file).toBe("benchmarks/transfer.circuit.tsx")
  expect(model_run?.circuit_preview?.circuit_json?.[0]?.type).toBe("source_component")
  expect(model_run?.reference_preview?.title).toBe("Transfer curve")
  expect(model_run?.reference_preview?.reference_points).toEqual([
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ])
  expect(model_run?.reference_preview?.result_points?.[1]).toEqual({ x: 1, y: 0.9 })
  expect(model_run?.preview_options.map((option) => option.benchmark_id)).toEqual(["output", "transfer"])

  await loadModelSelectedPreview({
    model_dir,
    tsci_bin: tsci_path,
    benchmark_id: "output",
  })
  const output_verification = await verifySimulationBenchmark({
    model_dir,
    benchmark_id: "output",
  })
  await writeSimulationValidationReport(model_dir, [transfer_verification, output_verification])
  const selected_preview = await loadModelSelectedPreview({
    model_dir,
    tsci_bin: tsci_path,
    benchmark_id: "output",
  })
  expect(selected_preview?.circuit_preview?.source_file).toBe("benchmarks/output.circuit.tsx")
  expect(
    (selected_preview?.circuit_preview?.circuit_json?.[0] as { source_component_id?: string } | undefined)
      ?.source_component_id,
  ).toBe("output")
  expect(selected_preview?.reference_preview?.title).toBe("Output response")
  expect(selected_preview?.reference_preview?.reference_points[1]).toEqual({ x: 1, y: 2 })
  expect(selected_preview?.reference_preview?.result_points?.[1]).toEqual({ x: 1, y: 2.1 })

  await Bun.write(join(model_dir, "model.lib"), "revision-two")
  await monitor.sync()
  expect(
    (
      store.getModelRun("model_1")?.circuit_preview?.circuit_json?.[0] as
        | { source_component_id?: string }
        | undefined
    )?.source_component_id,
  ).toBe("transfer-revision-two")

  monitor.stop()
  await rm(job_dir, { recursive: true, force: true })
})
