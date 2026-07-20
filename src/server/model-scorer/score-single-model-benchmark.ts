import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { ModelValidationBenchmark } from "@/shared/job-types"
import {
  BenchmarkDefinition,
  BenchmarkManifest,
  Point,
  ScoreBenchmarkOptions,
  parseBenchmarkManifest,
  resolveWorkspaceFile,
} from "./parse-benchmark-manifest"

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

export function transform(input: { value: number; scale: "linear" | "log"; label: string }): number {
  const { value, scale, label } = input
  if (scale === "linear") return value
  if (value <= 0) throw new Error(`${label} must be positive when using a logarithmic scale`)
  return Math.log10(value)
}

function interpolate(input: { points: Point[]; x: number; x_scale: "linear" | "log" }): number {
  const { points, x, x_scale } = input
  const transformed_x = transform({ value: x, scale: x_scale, label: "x" })
  const first_x = transform({ value: points[0]!.x, scale: x_scale, label: "result x" })
  const last_x = transform({ value: points.at(-1)!.x, scale: x_scale, label: "result x" })
  if (transformed_x < first_x || transformed_x > last_x) {
    throw new Error(`Reference x=${x} is outside the simulated result range`)
  }

  for (let index = 1; index < points.length; index += 1) {
    const right = points[index]!
    const right_x = transform({ value: right.x, scale: x_scale, label: "result x" })
    if (right_x < transformed_x) continue
    const left = points[index - 1]!
    const left_x = transform({ value: left.x, scale: x_scale, label: "result x" })
    if (right_x === left_x) return right.y
    const ratio = (transformed_x - left_x) / (right_x - left_x)
    return left.y + ratio * (right.y - left.y)
  }
  return points.at(-1)!.y
}

export async function scoreBenchmark(input: {
  model_dir: string
  benchmark: BenchmarkDefinition
  options?: ScoreBenchmarkOptions
}): Promise<ModelValidationBenchmark> {
  const { model_dir, benchmark } = input
  const options = input.options ?? {}
  try {
    const reference_points = await readCsvPoints(resolveWorkspaceFile(model_dir, benchmark.reference_file))
    const result_file =
      options.result_file_override ??
      (options.results_directory_override
        ? join(options.results_directory_override, `${benchmark.id}.csv`)
        : resolveWorkspaceFile(model_dir, benchmark.result_file))
    const result_points = await readCsvPoints(result_file)
    const x_scale = benchmark.x_scale ?? "linear"
    const y_scale = benchmark.y_scale ?? "linear"
    const target_values = reference_points.map((point) =>
      transform({ value: point.y, scale: y_scale, label: "reference y" }),
    )
    const target_min = Math.min(...target_values)
    const target_max = Math.max(...target_values)
    const target_abs_max = Math.max(...target_values.map(Math.abs))
    const normalization_span = Math.max(target_max - target_min, target_abs_max * 0.05, 1e-12)
    const normalized_errors = reference_points.map((reference_point) => {
      const simulated_y = interpolate({ points: result_points, x: reference_point.x, x_scale })
      const transformed_simulated_y = transform({
        value: simulated_y,
        scale: y_scale,
        label: "simulated y",
      })
      const transformed_reference_y = transform({
        value: reference_point.y,
        scale: y_scale,
        label: "reference y",
      })
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

export async function readBenchmarkManifest(model_dir: string): Promise<BenchmarkManifest> {
  const manifest_value: unknown = JSON.parse(await readFile(join(model_dir, "benchmarks.json"), "utf8"))
  return parseBenchmarkManifest(manifest_value)
}

export function requireBenchmark(manifest: BenchmarkManifest, benchmark_id: string): BenchmarkDefinition {
  const benchmark = manifest.benchmarks.find((candidate) => candidate.id === benchmark_id)
  if (!benchmark) throw new Error(`Benchmark ${benchmark_id} was not found in benchmarks.json`)
  return benchmark
}

export async function scoreSingleModelBenchmark(input: {
  model_dir: string
  benchmark_id: string
  result_file_override?: string
}): Promise<ModelValidationBenchmark> {
  const { model_dir, benchmark_id, result_file_override } = input
  const manifest = await readBenchmarkManifest(model_dir)
  return scoreBenchmark({
    model_dir,
    benchmark: requireBenchmark(manifest, benchmark_id),
    options: { result_file_override },
  })
}
