import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { isRecord, parseSimulationDefinition } from "./parse-simulation-definition"
import { SimulationExtractionDefinition } from "./types"

export async function getSimulationRunCount(model_dir: string): Promise<number> {
  const manifest: unknown = JSON.parse(await readFile(join(model_dir, "benchmarks.json"), "utf8"))
  if (!isRecord(manifest) || !Array.isArray(manifest.benchmarks) || manifest.benchmarks.length === 0) {
    throw new Error("benchmarks.json has no benchmark list")
  }
  for (const benchmark of manifest.benchmarks) {
    if (!isRecord(benchmark) || typeof benchmark.id !== "string") {
      throw new Error("benchmarks.json contains an invalid benchmark")
    }
    await readSimulationDefinition(model_dir, benchmark.id)
  }
  return manifest.benchmarks.length
}

export async function readSimulationDefinition(
  model_dir: string,
  benchmark_id: string,
): Promise<SimulationExtractionDefinition> {
  const manifest: unknown = JSON.parse(await readFile(join(model_dir, "benchmarks.json"), "utf8"))
  if (!isRecord(manifest) || !Array.isArray(manifest.benchmarks)) {
    throw new Error("benchmarks.json has no benchmark list")
  }
  const benchmark = manifest.benchmarks.find(
    (candidate) => isRecord(candidate) && candidate.id === benchmark_id,
  )
  if (!isRecord(benchmark)) throw new Error(`benchmarks.json has no ${benchmark_id} benchmark`)
  return parseSimulationDefinition(benchmark.simulation)
}

export async function validateSimulationDefinitions(
  model_dir: string,
  benchmark_ids: string[],
): Promise<void> {
  await Promise.all(benchmark_ids.map((benchmark_id) => readSimulationDefinition(model_dir, benchmark_id)))
}
