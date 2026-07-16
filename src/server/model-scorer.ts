import { readFile } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import type { ModelValidationBenchmark, ModelValidationSummary } from "@/shared/job-types"

interface Point {
  x: number
  y: number
}

export interface BenchmarkDefinition {
  id: string
  title: string
  source: {
    page: number
    figure?: string
  }
  critical: boolean
  weight: number
  tolerance: number
  max_error_tolerance?: number
  x_scale?: "linear" | "log"
  y_scale?: "linear" | "log"
  reference_file: string
  result_file: string
  simulation?: unknown
}

export interface BenchmarkManifest {
  version: 1
  locked_at: string
  benchmarks: BenchmarkDefinition[]
}

export interface ModelValidationReport extends ModelValidationSummary {
  version: 1
  generated_at: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseBenchmarkManifest(value: unknown): BenchmarkManifest {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.locked_at !== "string" ||
    !value.locked_at.trim() ||
    !Number.isFinite(new Date(value.locked_at).valueOf())
  ) {
    throw new Error("benchmarks.json must contain a version 1 locked benchmark manifest")
  }
  if (!Array.isArray(value.benchmarks) || value.benchmarks.length === 0) {
    throw new Error("benchmarks.json must contain at least one benchmark")
  }

  const benchmarks = value.benchmarks.map((entry, index): BenchmarkDefinition => {
    if (!isRecord(entry)) throw new Error(`Benchmark ${index + 1} must be an object`)
    const source = entry.source
    if (
      !isRecord(source) ||
      typeof source.page !== "number" ||
      !Number.isInteger(source.page) ||
      source.page < 1
    ) {
      throw new Error(`Benchmark ${index + 1} must cite a datasheet page`)
    }
    const required_strings = ["id", "title", "reference_file", "result_file"] as const
    for (const key of required_strings) {
      if (typeof entry[key] !== "string" || entry[key].trim() === "") {
        throw new Error(`Benchmark ${index + 1} has no ${key}`)
      }
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(entry.id as string)) {
      throw new Error(`Benchmark ${index + 1} has an invalid id`)
    }
    const reference_file = entry.reference_file as string
    if (
      !reference_file.startsWith("evidence/") ||
      reference_file.includes("\\") ||
      reference_file.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      throw new Error(`Benchmark ${String(entry.id)} reference_file must stay under evidence/`)
    }
    if (entry.result_file !== `results/champion/${entry.id}.csv`) {
      throw new Error(
        `Benchmark ${String(entry.id)} result_file must be results/champion/${String(entry.id)}.csv`,
      )
    }
    if (typeof entry.critical !== "boolean") {
      throw new Error(`Benchmark ${String(entry.id)} must declare whether it is critical`)
    }
    if (typeof entry.weight !== "number" || !Number.isFinite(entry.weight) || entry.weight <= 0) {
      throw new Error(`Benchmark ${String(entry.id)} has an invalid weight`)
    }
    if (typeof entry.tolerance !== "number" || !Number.isFinite(entry.tolerance) || entry.tolerance <= 0) {
      throw new Error(`Benchmark ${String(entry.id)} has an invalid tolerance`)
    }
    if (
      entry.max_error_tolerance !== undefined &&
      (typeof entry.max_error_tolerance !== "number" ||
        !Number.isFinite(entry.max_error_tolerance) ||
        entry.max_error_tolerance <= 0)
    ) {
      throw new Error(`Benchmark ${String(entry.id)} has an invalid max-error tolerance`)
    }
    if (entry.x_scale !== undefined && entry.x_scale !== "linear" && entry.x_scale !== "log") {
      throw new Error(`Benchmark ${String(entry.id)} has an invalid x scale`)
    }
    if (entry.y_scale !== undefined && entry.y_scale !== "linear" && entry.y_scale !== "log") {
      throw new Error(`Benchmark ${String(entry.id)} has an invalid y scale`)
    }

    return {
      id: entry.id as string,
      title: entry.title as string,
      source: {
        page: source.page,
        figure: typeof source.figure === "string" ? source.figure : undefined,
      },
      critical: entry.critical,
      weight: entry.weight,
      tolerance: entry.tolerance,
      max_error_tolerance:
        typeof entry.max_error_tolerance === "number" ? entry.max_error_tolerance : undefined,
      x_scale: entry.x_scale as "linear" | "log" | undefined,
      y_scale: entry.y_scale as "linear" | "log" | undefined,
      reference_file,
      result_file: entry.result_file as string,
      simulation: entry.simulation,
    }
  })

  if (new Set(benchmarks.map((benchmark) => benchmark.id)).size !== benchmarks.length) {
    throw new Error("Benchmark ids must be unique")
  }
  return { version: 1, locked_at: value.locked_at, benchmarks }
}

function resolveWorkspaceFile(model_dir: string, file_path: string): string {
  const resolved_root = resolve(model_dir)
  const resolved_file = resolve(resolved_root, file_path)
  if (!resolved_file.startsWith(`${resolved_root}${sep}`)) {
    throw new Error(`Benchmark file escapes the model workspace: ${file_path}`)
  }
  return resolved_file
}

export async function readCsvPoints(file_path: string): Promise<Point[]> {
  const text = await readFile(file_path, "utf8")
  const points: Point[] = []
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const columns = trimmed.split(/[,\t]/).map((column) => column.trim())
    if (columns.length < 2) throw new Error(`${file_path}:${index + 1} must contain x,y values`)
    const x = Number(columns[0])
    const y = Number(columns[1])
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      if (points.length === 0) continue
      throw new Error(`${file_path}:${index + 1} contains a non-numeric x or y value`)
    }
    points.push({ x, y })
  }
  if (points.length < 2) throw new Error(`${file_path} must contain at least two numeric points`)
  points.sort((first, second) => first.x - second.x)
  for (let index = 1; index < points.length; index += 1) {
    if (points[index]!.x === points[index - 1]!.x) {
      throw new Error(`${file_path} contains duplicate x=${points[index]!.x}`)
    }
  }
  return points
}

function transform(value: number, scale: "linear" | "log", label: string): number {
  if (scale === "linear") return value
  if (value <= 0) throw new Error(`${label} must be positive when using a logarithmic scale`)
  return Math.log10(value)
}

function interpolate(points: Point[], x: number, x_scale: "linear" | "log"): number {
  const transformed_x = transform(x, x_scale, "x")
  const first_x = transform(points[0]!.x, x_scale, "result x")
  const last_x = transform(points.at(-1)!.x, x_scale, "result x")
  if (transformed_x < first_x || transformed_x > last_x) {
    throw new Error(`Reference x=${x} is outside the simulated result range`)
  }

  for (let index = 1; index < points.length; index += 1) {
    const right = points[index]!
    const right_x = transform(right.x, x_scale, "result x")
    if (right_x < transformed_x) continue
    const left = points[index - 1]!
    const left_x = transform(left.x, x_scale, "result x")
    if (right_x === left_x) return right.y
    const ratio = (transformed_x - left_x) / (right_x - left_x)
    return left.y + ratio * (right.y - left.y)
  }
  return points.at(-1)!.y
}

async function scoreBenchmark(
  model_dir: string,
  benchmark: BenchmarkDefinition,
  results_directory_override?: string,
): Promise<ModelValidationBenchmark> {
  try {
    const reference_points = await readCsvPoints(resolveWorkspaceFile(model_dir, benchmark.reference_file))
    const result_file = results_directory_override
      ? join(results_directory_override, `${benchmark.id}.csv`)
      : resolveWorkspaceFile(model_dir, benchmark.result_file)
    const result_points = await readCsvPoints(result_file)
    const x_scale = benchmark.x_scale ?? "linear"
    const y_scale = benchmark.y_scale ?? "linear"
    const target_values = reference_points.map((point) => transform(point.y, y_scale, "reference y"))
    const target_min = Math.min(...target_values)
    const target_max = Math.max(...target_values)
    const target_abs_max = Math.max(...target_values.map(Math.abs))
    const normalization_span = Math.max(target_max - target_min, target_abs_max * 0.05, 1e-12)
    const normalized_errors = reference_points.map((reference_point) => {
      const simulated_y = interpolate(result_points, reference_point.x, x_scale)
      const transformed_simulated_y = transform(simulated_y, y_scale, "simulated y")
      const transformed_reference_y = transform(reference_point.y, y_scale, "reference y")
      return Math.abs(transformed_simulated_y - transformed_reference_y) / normalization_span
    })
    const normalized_rmse = Math.sqrt(
      normalized_errors.reduce((total, error) => total + error * error, 0) / normalized_errors.length,
    )
    const normalized_max_error = Math.max(...normalized_errors)
    const max_error_tolerance = benchmark.max_error_tolerance ?? benchmark.tolerance * 2
    return {
      benchmark_id: benchmark.id,
      title: benchmark.title,
      critical: benchmark.critical,
      tolerance: benchmark.tolerance,
      normalized_rmse,
      normalized_max_error,
      passed: normalized_rmse <= benchmark.tolerance && normalized_max_error <= max_error_tolerance,
    }
  } catch (error) {
    return {
      benchmark_id: benchmark.id,
      title: benchmark.title,
      critical: benchmark.critical,
      tolerance: benchmark.tolerance,
      passed: false,
      error_message: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function validateBenchmarkReferenceFiles(
  model_dir: string,
  manifest: BenchmarkManifest,
): Promise<void> {
  await Promise.all(
    manifest.benchmarks.map(async (benchmark) => {
      const points = await readCsvPoints(resolveWorkspaceFile(model_dir, benchmark.reference_file))
      const x_scale = benchmark.x_scale ?? "linear"
      const y_scale = benchmark.y_scale ?? "linear"
      for (const point of points) {
        transform(point.x, x_scale, `${benchmark.id} reference x`)
        transform(point.y, y_scale, `${benchmark.id} reference y`)
      }
    }),
  )
}

function interpolateReference(points: Point[], x: number, x_scale: "linear" | "log"): number {
  const transformed_x = transform(x, x_scale, "sweep x")
  const first_x = transform(points[0]!.x, x_scale, "reference x")
  const last_x = transform(points.at(-1)!.x, x_scale, "reference x")
  if (transformed_x <= first_x) return points[0]!.y
  if (transformed_x >= last_x) return points.at(-1)!.y
  for (let index = 1; index < points.length; index += 1) {
    const right = points[index]!
    const right_x = transform(right.x, x_scale, "reference x")
    if (right_x < transformed_x) continue
    const left = points[index - 1]!
    const left_x = transform(left.x, x_scale, "reference x")
    const ratio = (transformed_x - left_x) / (right_x - left_x)
    return left.y + ratio * (right.y - left.y)
  }
  return points.at(-1)!.y
}

/**
 * Reject a parameter-sweep grid that cannot faithfully re-render its own
 * reference data when the published curve is sampled at the declared sweep
 * coordinates. This prevents an immutable benchmark whose interpolation error
 * alone is larger than its tolerance before any DUT model is involved.
 */
export async function validateBenchmarkSweepSelfRepresentation(
  model_dir: string,
  manifest: BenchmarkManifest,
): Promise<void> {
  for (const benchmark of manifest.benchmarks) {
    if (!isRecord(benchmark.simulation) || benchmark.simulation.kind !== "parameter_sweep") continue
    if (!Array.isArray(benchmark.simulation.points)) continue
    const sweep_x = benchmark.simulation.points.flatMap((point) =>
      isRecord(point) && typeof point.x === "number" && Number.isFinite(point.x) ? [point.x] : [],
    )
    if (sweep_x.length < 2) continue
    sweep_x.sort((first, second) => first - second)
    const reference_points = await readCsvPoints(resolveWorkspaceFile(model_dir, benchmark.reference_file))
    const x_scale = benchmark.x_scale ?? "linear"
    const y_scale = benchmark.y_scale ?? "linear"
    const first_reference_x = transform(reference_points[0]!.x, x_scale, "reference x")
    const last_reference_x = transform(reference_points.at(-1)!.x, x_scale, "reference x")
    if (
      transform(sweep_x[0]!, x_scale, "sweep x") > first_reference_x ||
      transform(sweep_x.at(-1)!, x_scale, "sweep x") < last_reference_x
    ) {
      throw new Error(`Benchmark ${benchmark.id} sweep range does not cover every reference x value`)
    }
    const ideal_points = sweep_x.map((x) => ({
      x,
      y: interpolateReference(reference_points, x, x_scale),
    }))
    const targets = reference_points.map((point) => transform(point.y, y_scale, "reference y"))
    const target_min = Math.min(...targets)
    const target_max = Math.max(...targets)
    const target_abs_max = Math.max(...targets.map(Math.abs))
    const normalization_span = Math.max(target_max - target_min, target_abs_max * 0.05, 1e-12)
    const errors = reference_points.map((point) => {
      const result_y = interpolate(ideal_points, point.x, x_scale)
      return (
        Math.abs(
          transform(result_y, y_scale, "sampled reference y") - transform(point.y, y_scale, "reference y"),
        ) / normalization_span
      )
    })
    const normalized_rmse = Math.sqrt(
      errors.reduce((total, error) => total + error * error, 0) / errors.length,
    )
    const normalized_max_error = Math.max(...errors)
    const max_error_tolerance = benchmark.max_error_tolerance ?? benchmark.tolerance * 2
    if (normalized_rmse > benchmark.tolerance + 1e-12 || normalized_max_error > max_error_tolerance + 1e-12) {
      throw new Error(
        `Benchmark ${benchmark.id} sweep grid is too sparse for its locked tolerance: reference self-representation has normalized RMSE ${normalized_rmse.toFixed(6)} (limit ${benchmark.tolerance}) and max error ${normalized_max_error.toFixed(6)} (limit ${max_error_tolerance}). Add sweep points at the missing curve bends before locking.`,
      )
    }
  }
}

export async function scoreModelBenchmarks(
  model_dir: string,
  options: { results_directory_override?: string } = {},
): Promise<ModelValidationReport> {
  const manifest_value: unknown = JSON.parse(await readFile(join(model_dir, "benchmarks.json"), "utf8"))
  const manifest = parseBenchmarkManifest(manifest_value)
  const benchmarks = await Promise.all(
    manifest.benchmarks.map((benchmark) =>
      scoreBenchmark(model_dir, benchmark, options.results_directory_override),
    ),
  )
  const passing_count = benchmarks.filter((benchmark) => benchmark.passed).length
  const critical_benchmarks = benchmarks.filter((benchmark) => benchmark.critical)
  const critical_passing_count = critical_benchmarks.filter((benchmark) => benchmark.passed).length
  let total_weight = 0
  let weighted_error = 0
  let worst_normalized_error: number | undefined
  for (const [index, result] of benchmarks.entries()) {
    const weight = manifest.benchmarks[index]!.weight
    if (result.normalized_rmse === undefined) continue
    total_weight += weight
    weighted_error += result.normalized_rmse * weight
    worst_normalized_error = Math.max(worst_normalized_error ?? 0, result.normalized_max_error ?? 0)
  }

  return {
    version: 1,
    generated_at: new Date().toISOString(),
    benchmark_count: benchmarks.length,
    passing_count,
    critical_count: critical_benchmarks.length,
    critical_passing_count,
    score: total_weight > 0 ? weighted_error / total_weight : undefined,
    worst_normalized_error,
    all_critical_passed: critical_passing_count === critical_benchmarks.length,
    all_passed: passing_count === benchmarks.length,
    benchmarks,
  }
}
