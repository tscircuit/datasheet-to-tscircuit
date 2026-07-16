import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  parseBenchmarkManifest,
  scoreModelBenchmarks,
  validateBenchmarkSweepSelfRepresentation,
} from "@/server/model-scorer"

test("model scorer evaluates every locked benchmark from numeric CSV data", async () => {
  const model_dir = await mkdtemp(join(tmpdir(), "datasheet-model-scorer-"))
  await Promise.all([
    mkdir(join(model_dir, "evidence"), { recursive: true }),
    mkdir(join(model_dir, "results", "champion"), { recursive: true }),
  ])
  await Bun.write(
    join(model_dir, "benchmarks.json"),
    JSON.stringify({
      version: 1,
      locked_at: new Date().toISOString(),
      benchmarks: [
        {
          id: "transfer",
          title: "Transfer curve",
          source: { page: 4, figure: "Figure 2" },
          critical: true,
          weight: 1,
          tolerance: 0.05,
          reference_file: "evidence/transfer.csv",
          result_file: "results/champion/transfer.csv",
        },
        {
          id: "dropout",
          title: "Dropout curve",
          source: { page: 5 },
          critical: false,
          weight: 1,
          tolerance: 0.05,
          reference_file: "evidence/dropout.csv",
          result_file: "results/champion/dropout.csv",
        },
      ],
    }),
  )
  await Promise.all([
    Bun.write(join(model_dir, "evidence", "transfer.csv"), "x,y\n0,0\n1,1\n2,2\n"),
    Bun.write(join(model_dir, "results", "champion", "transfer.csv"), "x,y\n0,0\n1,1\n2,2\n"),
    Bun.write(join(model_dir, "evidence", "dropout.csv"), "x,y\n0,0\n1,1\n2,2\n"),
    Bun.write(join(model_dir, "results", "champion", "dropout.csv"), "x,y\n0,0\n1,2\n2,4\n"),
  ])

  const report = await scoreModelBenchmarks(model_dir)

  expect(report.benchmark_count).toBe(2)
  expect(report.passing_count).toBe(1)
  expect(report.all_critical_passed).toBe(true)
  expect(report.all_passed).toBe(false)
  expect(report.benchmarks[0]?.normalized_rmse).toBe(0)
  expect(report.benchmarks[1]?.passed).toBe(false)

  await rm(model_dir, { recursive: true, force: true })
})

test("benchmark lock rejects a sweep grid whose interpolation cannot represent its reference", async () => {
  const model_dir = await mkdtemp(join(tmpdir(), "datasheet-model-sparse-grid-"))
  await mkdir(join(model_dir, "evidence"), { recursive: true })
  await Bun.write(join(model_dir, "evidence", "bend.csv"), "x,y\n0,0\n0.5,1\n1,0\n")
  const base = {
    version: 1 as const,
    locked_at: new Date().toISOString(),
    benchmarks: [
      {
        id: "bend",
        title: "Sharp bend",
        source: { page: 2 },
        critical: true,
        weight: 1,
        tolerance: 0.01,
        max_error_tolerance: 0.02,
        reference_file: "evidence/bend.csv",
        result_file: "results/champion/bend.csv",
        simulation: {
          kind: "parameter_sweep",
          probe_name: "RESULT",
          dut_spice_node: "OUT",
          reducer: "last",
          points: [
            { x: 0, props: { input: 0 } },
            { x: 1, props: { input: 1 } },
          ],
        },
      },
    ],
  }
  await expect(
    validateBenchmarkSweepSelfRepresentation(model_dir, parseBenchmarkManifest(base)),
  ).rejects.toThrow("sweep grid is too sparse")
  base.benchmarks[0]!.simulation.points.splice(1, 0, { x: 0.5, props: { input: 0.5 } })
  await expect(
    validateBenchmarkSweepSelfRepresentation(model_dir, parseBenchmarkManifest(base)),
  ).resolves.toBeUndefined()
  await rm(model_dir, { recursive: true, force: true })
})
