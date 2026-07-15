import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  getVerifiedResultFile,
  verifySimulationBenchmark,
  writeSimulationValidationReport,
} from "@/server/model-simulation-validator"

test("simulation verification rejects solver errors and hashes extracted simulator curves", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-model-simulation-validation-"))
  const model_dir = join(job_dir, "spice")
  const circuit_dir = join(job_dir, "dist", "spice", "benchmarks", "transient")
  await Promise.all([mkdir(model_dir, { recursive: true }), mkdir(circuit_dir, { recursive: true })])
  await Bun.write(
    join(model_dir, "benchmarks.json"),
    JSON.stringify({
      version: 1,
      locked_at: new Date().toISOString(),
      benchmarks: [
        {
          id: "transient",
          simulation: {
            kind: "transient_voltage",
            probe_name: "VOUT",
            scale: 2,
            offset: 1,
          },
        },
      ],
    }),
  )
  await Bun.write(
    join(circuit_dir, "circuit.json"),
    JSON.stringify([
      {
        type: "simulation_unknown_experiment_error",
        message: "Singular matrix (real)",
      },
    ]),
  )

  const failed = await verifySimulationBenchmark({ model_dir, benchmark_id: "transient" })
  expect(failed.passed).toBe(false)
  expect(failed.error_message).toContain("Singular matrix")

  await Bun.write(
    join(circuit_dir, "circuit.json"),
    JSON.stringify([
      {
        type: "simulation_transient_voltage_graph",
        name: "VOUT",
        timestamps_ms: [0, 0.5, 1],
        voltage_levels: [0, 1, 2],
      },
    ]),
  )
  const passed = await verifySimulationBenchmark({ model_dir, benchmark_id: "transient" })
  expect(passed.passed).toBe(true)
  expect(await Bun.file(join(model_dir, "results", "verified", "transient.csv")).text()).toBe(
    "x,y\n0,1\n0.5,3\n1,5\n",
  )
  await writeSimulationValidationReport(model_dir, [passed])
  expect(await getVerifiedResultFile(model_dir, "transient")).toBe("results/verified/transient.csv")

  await Bun.write(join(model_dir, "results", "verified", "transient.csv"), "x,y\n0,999\n1,999\n")
  expect(await getVerifiedResultFile(model_dir, "transient")).toBeUndefined()

  await rm(job_dir, { recursive: true, force: true })
})
