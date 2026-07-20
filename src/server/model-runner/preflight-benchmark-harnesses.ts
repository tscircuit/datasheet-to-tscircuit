import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import type { JobLogStream } from "@/shared/job-types"
import { parseTypicalApplicationPlan } from "../job-runner"
import { ModelInfrastructureError, ModelRunnerContext } from "./stream-model-process"
import { listModelBenchFiles } from "./list-model-bench-files"
import {
  getBenchmarkApplicationErrors,
  getBenchmarkApplicationPlan,
  getStubComponentPins,
} from "./get-benchmark-application-plan"
import { writeServerIntegratedComponent } from "./attach-model-to-generated-component"
import {
  ValidationBuildResult,
  executeValidationBuild,
  getValidationConcurrency,
  runValidationTaskPool,
} from "./validate-champion"

export async function preflightBenchmarkHarnesses(input: {
  model_run_id: string
  job_id: string
  job_dir: string
  model_dir: string
  signal: AbortSignal
  context: ModelRunnerContext
  append: (stream: JobLogStream, message: string) => Promise<void>
}): Promise<void> {
  const temporary_component = join(input.model_dir, "component-with-model.circuit.tsx")
  const saved_root = join(input.model_dir, ".benchmark-harness-preflight")
  const benchmark_files = await listModelBenchFiles(input.model_dir)
  const generated_directories = benchmark_files.map((benchmark_file) =>
    join(input.job_dir, "dist", "spice", "benchmarks", benchmark_file.replace(/\.circuit\.tsx$/i, "")),
  )
  if (await Bun.file(temporary_component).exists()) {
    throw new Error("A model wrapper exists before benchmark simulation preflight")
  }
  const component_source = await readFile(join(input.model_dir, "component.circuit.tsx"), "utf8")
  const component_circuit_json = input.context.job_store.getJob(input.job_id)?.circuit_json
  const pins = getStubComponentPins({ component_circuit_json, component_source })
  const model_source = `.SUBCKT SERVER_BENCHMARK_STUB ${pins.map((pin) => pin.spice_node).join(" ")}\nRREF STUB_REF 0 1G\n${pins
    .map((pin, index) => `RSTUB${index + 1} ${pin.spice_node} STUB_REF 1G`)
    .join("\n")}\n.ENDS SERVER_BENCHMARK_STUB\n`
  await writeServerIntegratedComponent({
    model_dir: input.model_dir,
    manifest: {
      version: 1,
      part_number: "SERVER_BENCHMARK_STUB",
      dialect: "portable",
      entry_name: "SERVER_BENCHMARK_STUB",
      model_file: "model.lib",
      revision: "preflight",
      simulator: "ngspice",
      generated_at: new Date().toISOString(),
      pins,
    },
    model_source,
  })
  try {
    const application_plan_path = join(input.model_dir, "typical-application-plan.json")
    const parsed_application_plan = (await Bun.file(application_plan_path).exists())
      ? parseTypicalApplicationPlan(JSON.parse(await readFile(application_plan_path, "utf8")))
      : undefined
    const benchmark_application_plan =
      parsed_application_plan?.availability === "documented"
        ? getBenchmarkApplicationPlan(parsed_application_plan)
        : undefined
    await input.append(
      "system",
      `Running one server-owned stub-model simulation for each of ${benchmark_files.length} provisional benchmark harness(es) before locking…\n`,
    )
    const results = new Map<string, ValidationBuildResult>()
    await runValidationTaskPool({
      tasks: benchmark_files,
      concurrency: getValidationConcurrency(),
      signal: input.signal,
      run: async (benchmark_file) => {
        const benchmark_id = benchmark_file.replace(/\.circuit\.tsx$/i, "")
        let result = await executeValidationBuild({
          benchmark_file,
          run: {
            run_id: "preflight",
            source_path: join(input.model_dir, "benchmarks", benchmark_file),
            generated_path: join(input.job_dir, "dist", "spice", "benchmarks", benchmark_id, "circuit.json"),
            saved_path: join(saved_root, benchmark_id, "circuit.json"),
          },
          model_dir: input.model_dir,
          signal: input.signal,
          tsci_bin: input.context.tsci_bin,
          append: input.append,
        })
        if (result.exit_code === 0 && result.path && benchmark_application_plan) {
          const application_errors = await getBenchmarkApplicationErrors(
            benchmark_application_plan,
            result.path,
          )
          if (application_errors.length > 0) {
            result = {
              ...result,
              exit_code: 1,
              failure_kind: "benchmark_structure",
              error_message: `datasheet application topology mismatch: ${application_errors.join("; ")}`,
            }
          }
        }
        results.set(benchmark_file, result)
      },
    })
    if (input.signal.aborted) throw new Error("Benchmark simulation preflight was cancelled")
    const infrastructure_failures = [...results.entries()].filter(
      ([, result]) => result.failure_kind === "infrastructure",
    )
    if (infrastructure_failures.length > 0) {
      throw new ModelInfrastructureError(
        `Benchmark simulation preflight infrastructure failed: ${infrastructure_failures
          .map(([file, result]) => `${file}: ${result.error_message ?? "unknown infrastructure error"}`)
          .join(" | ")}`,
      )
    }
    const failures = benchmark_files.flatMap((benchmark_file) => {
      const result = results.get(benchmark_file)
      return !result || result.exit_code !== 0 || !result.path
        ? [
            `${benchmark_file}: ${
              result?.error_message ?? "stub-model simulation did not produce Circuit JSON"
            }`,
          ]
        : []
    })
    if (failures.length > 0) {
      throw new Error(`Benchmark simulation preflight failed: ${failures.join(" | ")}`)
    }
    await input.append("system", "Every provisional benchmark harness completed stub-model simulation.\n")
  } finally {
    await Promise.all([
      rm(temporary_component, { force: true }),
      rm(saved_root, { recursive: true, force: true }),
      ...generated_directories.map((directory) => rm(directory, { recursive: true, force: true })),
    ])
  }
}
