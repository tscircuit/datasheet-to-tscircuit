import { ModelValidationReport } from "./parse-benchmark-manifest"
import { readBenchmarkManifest, scoreBenchmark } from "./score-single-model-benchmark"

export async function scoreModelBenchmarks(
  model_dir: string,
  options: { results_directory_override?: string } = {},
): Promise<ModelValidationReport> {
  const manifest = await readBenchmarkManifest(model_dir)
  const benchmarks = await Promise.all(
    manifest.benchmarks.map((benchmark) => scoreBenchmark({ model_dir, benchmark, options })),
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
