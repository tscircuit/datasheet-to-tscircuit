import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { parseBenchmarkManifest } from "../model-scorer"

export async function listModelBenchFiles(model_dir: string): Promise<string[]> {
  const manifest_value: unknown = JSON.parse(await readFile(join(model_dir, "benchmarks.json"), "utf8"))
  return parseBenchmarkManifest(manifest_value).benchmarks.map((benchmark) => `${benchmark.id}.circuit.tsx`)
}
