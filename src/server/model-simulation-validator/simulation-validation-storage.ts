import { createHash } from "node:crypto"
import { mkdir, readFile, rename, rm } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import { assertSafeBenchmarkId, isRecord } from "./parse-simulation-definition"
import { SimulationBenchmarkVerification, SimulationValidationReport } from "./types"

export function toCsv(points: Array<{ x: number; y: number }>): string {
  return `x,y\n${points.map((point) => `${point.x},${point.y}`).join("\n")}\n`
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

export async function writeTextAtomically(file_path: string, text: string): Promise<void> {
  await mkdir(dirname(file_path), { recursive: true })
  const temporary_path = `${file_path}.${crypto.randomUUID()}.tmp`
  await Bun.write(temporary_path, text)
  await rename(temporary_path, file_path)
}

export async function getModelSimulationSourceSignature(
  model_dir: string,
  benchmark_id: string,
): Promise<string> {
  assertSafeBenchmarkId(benchmark_id)
  const files = [
    join("benchmarks", `${benchmark_id}.circuit.tsx`),
    "model.lib",
    "component-with-model.circuit.tsx",
    "component.circuit.tsx",
    "benchmarks.json",
  ]
  const hash = createHash("sha256")
  for (const file of files) {
    hash.update(file)
    hash.update("\0")
    hash.update(await readFile(join(model_dir, file), "utf8").catch(() => ""))
    hash.update("\0")
  }
  return hash.digest("hex")
}

export function getValidationRoot(model_dir: string): string {
  return join(dirname(model_dir), ".model-validation")
}

export function getVerifiedResultsDirectory(model_dir: string): string {
  return join(getValidationRoot(model_dir), "results")
}

export function resolveInside(root: string, file: string): string | undefined {
  const resolved_root = resolve(root)
  const resolved_file = resolve(resolved_root, file)
  return resolved_file.startsWith(`${resolved_root}${sep}`) ? resolved_file : undefined
}

export async function readTrustedReport(model_dir: string): Promise<SimulationValidationReport | undefined> {
  const value: unknown = await readFile(
    join(getValidationRoot(model_dir), "simulation-validation.json"),
    "utf8",
  )
    .then((text) => JSON.parse(text))
    .catch(() => undefined)
  if (
    !isRecord(value) ||
    value.version !== 2 ||
    !Array.isArray(value.benchmarks) ||
    value.benchmarks.some(
      (benchmark) =>
        !isRecord(benchmark) ||
        typeof benchmark.benchmark_id !== "string" ||
        typeof benchmark.passed !== "boolean" ||
        (benchmark.status !== undefined &&
          benchmark.status !== "building" &&
          benchmark.status !== "passed" &&
          benchmark.status !== "failed") ||
        typeof benchmark.generated_at !== "string",
    )
  ) {
    return undefined
  }
  return {
    version: 2,
    generated_at: typeof value.generated_at === "string" ? value.generated_at : new Date(0).toISOString(),
    benchmarks: value.benchmarks as SimulationBenchmarkVerification[],
  }
}

export async function getSimulationBenchmarkVerification(
  model_dir: string,
  benchmark_id: string,
): Promise<SimulationBenchmarkVerification | undefined> {
  assertSafeBenchmarkId(benchmark_id)
  const report = await readTrustedReport(model_dir)
  return report?.benchmarks.find((benchmark) => benchmark.benchmark_id === benchmark_id)
}

export async function writeArtifactCopies(input: {
  model_dir: string
  benchmark_id: string
  circuit_text: string
  source_text: string
}): Promise<
  Pick<
    SimulationBenchmarkVerification,
    "source_file" | "source_sha256" | "circuit_json_file" | "circuit_json_sha256"
  >
> {
  const trusted_root = getValidationRoot(input.model_dir)
  const trusted_benchmark_dir = join(trusted_root, "benchmarks", input.benchmark_id)
  const diagnostic_dir = join(input.model_dir, "validation-artifacts", input.benchmark_id)
  await Promise.all([
    mkdir(trusted_benchmark_dir, { recursive: true }),
    mkdir(diagnostic_dir, { recursive: true }),
  ])
  await Promise.all([
    writeTextAtomically(join(trusted_benchmark_dir, "circuit.json"), input.circuit_text),
    writeTextAtomically(join(trusted_benchmark_dir, "source.circuit.tsx"), input.source_text),
    writeTextAtomically(join(diagnostic_dir, "circuit.json"), input.circuit_text),
    writeTextAtomically(join(diagnostic_dir, "source.circuit.tsx"), input.source_text),
  ])
  return {
    source_file: relative(
      input.model_dir,
      join(input.model_dir, "benchmarks", `${input.benchmark_id}.circuit.tsx`),
    ),
    source_sha256: hashText(input.source_text),
    circuit_json_file: relative(trusted_root, join(trusted_benchmark_dir, "circuit.json")),
    circuit_json_sha256: hashText(input.circuit_text),
  }
}

export async function clearVerifiedSimulationResults(model_dir: string): Promise<void> {
  await Promise.all([
    rm(getValidationRoot(model_dir), { recursive: true, force: true }),
    rm(join(model_dir, "results", "verified"), { recursive: true, force: true }),
    rm(join(model_dir, "validation-artifacts"), { recursive: true, force: true }),
    rm(join(model_dir, "simulation-validation.json"), { force: true }),
  ])
}
