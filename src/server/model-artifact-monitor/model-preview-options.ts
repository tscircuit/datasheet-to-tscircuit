import { stat } from "node:fs/promises"
import { join, relative } from "node:path"
import type { ModelPreviewOption, ModelSelectedPreview } from "@/shared/job-types"
import { getVerifiedResultFile } from "../model-simulation-validator"
import { readBenchmarkRecords, readReferencePreview } from "./read-reference-preview"
import { readPersistedCircuitPreview, selectCircuitSource } from "./read-circuit-preview"

export async function listModelPreviewOptions(model_dir: string): Promise<ModelPreviewOption[]> {
  const benchmarks = await readBenchmarkRecords(model_dir)
  return (
    await Promise.all(
      benchmarks.map(async (benchmark): Promise<ModelPreviewOption | undefined> => {
        const benchmark_id = benchmark.id
        if (!benchmark_id || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(benchmark_id)) return undefined
        const file = join(model_dir, "benchmarks", `${benchmark_id}.circuit.tsx`)
        if (!(await stat(file).catch(() => undefined))?.isFile()) return undefined
        return {
          benchmark_id,
          title: benchmark?.title ?? benchmark_id,
          circuit_file: relative(model_dir, file),
          reference_file: benchmark?.reference_file,
          result_file: await getVerifiedResultFile(model_dir, benchmark_id).catch(() => undefined),
        }
      }),
    )
  )
    .filter((option): option is ModelPreviewOption => Boolean(option))
    .sort((first, second) => first.title.localeCompare(second.title))
}

export async function loadModelSelectedPreview(input: {
  model_dir: string
  benchmark_id: string
}): Promise<ModelSelectedPreview | undefined> {
  const source_path = await selectCircuitSource({
    model_dir: input.model_dir,
    current_benchmark: input.benchmark_id,
    require_exact: true,
  })
  if (!source_path) return undefined
  try {
    const circuit_preview = await readPersistedCircuitPreview({
      model_dir: input.model_dir,
      source_path,
      benchmark_id: input.benchmark_id,
    })
    const reference_preview = await readReferencePreview({
      model_dir: input.model_dir,
      current_benchmark: input.benchmark_id,
      require_exact: true,
      circuit_preview,
    })
    return { circuit_preview, reference_preview }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}
