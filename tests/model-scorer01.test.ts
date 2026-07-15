import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { scoreModelBenchmarks } from "@/server/model-scorer"

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
