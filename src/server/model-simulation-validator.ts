import { createHash } from "node:crypto"
import { mkdir, readFile, rm } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"

type ProbeReducer = "last" | "tail_mean" | "peak_to_peak" | "frequency_hz"

interface ProbePointDefinition {
  x: number
  probe_name: string
  reducer: ProbeReducer
  scale: number
  offset: number
}

type SimulationExtractionDefinition =
  | { kind: "transient_voltage"; probe_name: string; scale: number; offset: number }
  | { kind: "probe_sweep"; points: ProbePointDefinition[] }

interface SimulationGraph {
  name: string
  timestamps_ms: number[]
  voltage_levels: number[]
}

export interface SimulationBenchmarkVerification {
  benchmark_id: string
  passed: boolean
  error_message?: string
  verified_result_file?: string
  sha256?: string
}

interface SimulationValidationReport {
  version: 1
  generated_at: string
  benchmarks: SimulationBenchmarkVerification[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function optionalFiniteNumber(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`)
  return value
}

function parseReducer(value: unknown, fallback: ProbeReducer): ProbeReducer {
  if (value === undefined) return fallback
  if (value === "last" || value === "tail_mean" || value === "peak_to_peak" || value === "frequency_hz") {
    return value
  }
  throw new Error("simulation reducer must be last, tail_mean, peak_to_peak, or frequency_hz")
}

function parseSimulationDefinition(value: unknown): SimulationExtractionDefinition {
  if (!isRecord(value)) {
    throw new Error(
      "benchmark has no server-verifiable simulation extraction; add simulation.kind and probe mapping",
    )
  }
  if (value.kind === "transient_voltage") {
    return {
      kind: "transient_voltage",
      probe_name: requiredString(value.probe_name, "simulation.probe_name"),
      scale: optionalFiniteNumber(value.scale, 1, "simulation.scale"),
      offset: optionalFiniteNumber(value.offset, 0, "simulation.offset"),
    }
  }
  if (value.kind === "probe_sweep") {
    if (!Array.isArray(value.points) || value.points.length < 2) {
      throw new Error("simulation.points must contain at least two probe-sweep points")
    }
    return {
      kind: "probe_sweep",
      points: value.points.map((point, index) => {
        if (!isRecord(point)) throw new Error(`simulation point ${index + 1} must be an object`)
        if (typeof point.x !== "number" || !Number.isFinite(point.x)) {
          throw new Error(`simulation point ${index + 1} has an invalid x value`)
        }
        return {
          x: point.x,
          probe_name: requiredString(point.probe_name, `simulation point ${index + 1} probe_name`),
          reducer: parseReducer(point.reducer, "tail_mean"),
          scale: optionalFiniteNumber(point.scale, 1, `simulation point ${index + 1} scale`),
          offset: optionalFiniteNumber(point.offset, 0, `simulation point ${index + 1} offset`),
        }
      }),
    }
  }
  throw new Error("simulation.kind must be transient_voltage or probe_sweep")
}

async function readSimulationDefinition(
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

function parseSimulationOutput(value: unknown): { graphs: SimulationGraph[]; errors: string[] } {
  if (!Array.isArray(value)) throw new Error("simulation did not produce Circuit JSON")
  const errors: string[] = []
  const graphs: SimulationGraph[] = []
  for (const element of value) {
    if (!isRecord(element) || typeof element.type !== "string") continue
    if (element.type.startsWith("simulation_") && element.type.endsWith("_error")) {
      errors.push(typeof element.message === "string" ? element.message : element.type)
    }
    if (element.type !== "simulation_transient_voltage_graph") continue
    if (
      typeof element.name !== "string" ||
      !Array.isArray(element.timestamps_ms) ||
      !Array.isArray(element.voltage_levels)
    ) {
      continue
    }
    const timestamps_ms = element.timestamps_ms.filter(
      (entry): entry is number => typeof entry === "number" && Number.isFinite(entry),
    )
    const voltage_levels = element.voltage_levels.filter(
      (entry): entry is number => typeof entry === "number" && Number.isFinite(entry),
    )
    if (timestamps_ms.length === voltage_levels.length && timestamps_ms.length >= 2) {
      graphs.push({ name: element.name, timestamps_ms, voltage_levels })
    }
  }
  return { graphs, errors }
}

function requireGraph(graphs: SimulationGraph[], probe_name: string): SimulationGraph {
  const graph = graphs.find((candidate) => candidate.name === probe_name)
  if (!graph) throw new Error(`simulation produced no voltage graph named ${probe_name}`)
  return graph
}

function reduceGraph(graph: SimulationGraph, reducer: ProbeReducer): number {
  if (reducer === "last") return graph.voltage_levels.at(-1)!
  const tail_start = Math.floor(graph.voltage_levels.length * 0.8)
  const tail = graph.voltage_levels.slice(tail_start)
  if (reducer === "tail_mean") return tail.reduce((sum, value) => sum + value, 0) / tail.length
  if (reducer === "peak_to_peak") return Math.max(...tail) - Math.min(...tail)

  const search_start = Math.floor(graph.voltage_levels.length * 0.25)
  const levels = graph.voltage_levels.slice(search_start)
  const timestamps = graph.timestamps_ms.slice(search_start)
  const minimum = Math.min(...levels)
  const maximum = Math.max(...levels)
  if (maximum - minimum <= 1e-12) throw new Error(`${graph.name} has no measurable oscillation`)
  const threshold = (minimum + maximum) / 2
  const crossings: number[] = []
  for (let index = 1; index < levels.length; index += 1) {
    const left = levels[index - 1]!
    const right = levels[index]!
    if (left >= threshold || right < threshold || right === left) continue
    const ratio = (threshold - left) / (right - left)
    crossings.push(timestamps[index - 1]! + ratio * (timestamps[index]! - timestamps[index - 1]!))
  }
  if (crossings.length < 2) throw new Error(`${graph.name} has too few rising edges for frequency`)
  const periods = crossings.slice(1).map((crossing, index) => crossing - crossings[index]!)
  const average_period_ms = periods.reduce((sum, value) => sum + value, 0) / periods.length
  if (!(average_period_ms > 0)) throw new Error(`${graph.name} has an invalid oscillation period`)
  return 1_000 / average_period_ms
}

function toCsv(points: Array<{ x: number; y: number }>): string {
  return `x,y\n${points.map((point) => `${point.x},${point.y}`).join("\n")}\n`
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

export async function clearVerifiedSimulationResults(model_dir: string): Promise<void> {
  await Promise.all([
    rm(join(model_dir, "results", "verified"), { recursive: true, force: true }),
    rm(join(model_dir, "simulation-validation.json"), { force: true }),
  ])
}

export async function verifySimulationBenchmark(input: {
  model_dir: string
  benchmark_id: string
}): Promise<SimulationBenchmarkVerification> {
  try {
    const definition = await readSimulationDefinition(input.model_dir, input.benchmark_id)
    const job_dir = dirname(input.model_dir)
    const circuit_json_file = join(job_dir, "dist", "spice", "benchmarks", input.benchmark_id, "circuit.json")
    const circuit_json: unknown = JSON.parse(await readFile(circuit_json_file, "utf8"))
    const { graphs, errors } = parseSimulationOutput(circuit_json)
    if (errors.length > 0) throw new Error(errors.join("; "))

    const points =
      definition.kind === "transient_voltage"
        ? (() => {
            const graph = requireGraph(graphs, definition.probe_name)
            return graph.timestamps_ms.map((x, index) => ({
              x,
              y: graph.voltage_levels[index]! * definition.scale + definition.offset,
            }))
          })()
        : definition.points.map((point) => ({
            x: point.x,
            y:
              reduceGraph(requireGraph(graphs, point.probe_name), point.reducer) * point.scale + point.offset,
          }))
    const text = toCsv(points)
    const verified_file = join(input.model_dir, "results", "verified", `${input.benchmark_id}.csv`)
    await mkdir(dirname(verified_file), { recursive: true })
    await Bun.write(verified_file, text)
    return {
      benchmark_id: input.benchmark_id,
      passed: true,
      verified_result_file: relative(input.model_dir, verified_file),
      sha256: hashText(text),
    }
  } catch (error) {
    return {
      benchmark_id: input.benchmark_id,
      passed: false,
      error_message: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function writeSimulationValidationReport(
  model_dir: string,
  benchmarks: SimulationBenchmarkVerification[],
): Promise<void> {
  const report: SimulationValidationReport = {
    version: 1,
    generated_at: new Date().toISOString(),
    benchmarks,
  }
  await Bun.write(join(model_dir, "simulation-validation.json"), `${JSON.stringify(report, null, 2)}\n`)
}

export async function getVerifiedResultFile(
  model_dir: string,
  benchmark_id: string,
): Promise<string | undefined> {
  const report: unknown = JSON.parse(await readFile(join(model_dir, "simulation-validation.json"), "utf8"))
  if (!isRecord(report) || report.version !== 1 || !Array.isArray(report.benchmarks)) return undefined
  const result = report.benchmarks.find(
    (candidate) => isRecord(candidate) && candidate.benchmark_id === benchmark_id,
  )
  if (
    !isRecord(result) ||
    result.passed !== true ||
    typeof result.verified_result_file !== "string" ||
    typeof result.sha256 !== "string"
  ) {
    return undefined
  }
  const model_root = resolve(model_dir)
  const file_path = resolve(model_root, result.verified_result_file)
  if (!file_path.startsWith(`${model_root}${sep}`)) return undefined
  const text = await readFile(file_path, "utf8")
  return hashText(text) === result.sha256 ? result.verified_result_file : undefined
}

export async function hasCompleteVerifiedSimulationReport(model_dir: string): Promise<boolean> {
  const report: unknown = await readFile(join(model_dir, "simulation-validation.json"), "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => undefined)
  if (!isRecord(report) || report.version !== 1 || !Array.isArray(report.benchmarks)) return false
  const benchmark_ids = report.benchmarks.flatMap((candidate) => {
    if (!isRecord(candidate) || candidate.passed !== true || typeof candidate.benchmark_id !== "string") {
      return []
    }
    return [candidate.benchmark_id]
  })
  if (benchmark_ids.length === 0 || benchmark_ids.length !== report.benchmarks.length) return false
  const verified_files = await Promise.all(
    benchmark_ids.map((benchmark_id) => getVerifiedResultFile(model_dir, benchmark_id)),
  )
  return verified_files.every(Boolean)
}
