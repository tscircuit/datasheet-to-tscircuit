import { BenchmarkManifest, resolveWorkspaceFile } from "./parse-benchmark-manifest"
import { readCsvPoints, transform } from "./score-single-model-benchmark"

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
        if (point.x < 0) {
          throw new Error(`${benchmark.id} reference x must be non-negative elapsed time in milliseconds`)
        }
        transform({ value: point.x, scale: x_scale, label: `${benchmark.id} reference x` })
        transform({ value: point.y, scale: y_scale, label: `${benchmark.id} reference y` })
      }
    }),
  )
}
