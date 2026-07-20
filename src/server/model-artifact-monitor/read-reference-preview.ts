import { readdir, readFile, stat } from "node:fs/promises"
import { basename, join, relative } from "node:path"
import type { ModelCircuitPreview, ModelCurvePoint, ModelReferencePreview } from "@/shared/job-types"
import { extractSimulationResultPoints, parseSimulationDefinition } from "../model-simulation-validator"

interface BenchmarkPreviewRecord {
  id?: string
  title?: string
  reference_file?: string
  x_scale?: string
  y_scale?: string
  simulation?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseBenchmarks(value: unknown): BenchmarkPreviewRecord[] {
  if (!isRecord(value) || !Array.isArray(value.benchmarks)) return []
  return value.benchmarks.flatMap((benchmark) => {
    if (!isRecord(benchmark)) return []
    return [
      {
        id: typeof benchmark.id === "string" ? benchmark.id : undefined,
        title: typeof benchmark.title === "string" ? benchmark.title : undefined,
        reference_file: typeof benchmark.reference_file === "string" ? benchmark.reference_file : undefined,
        x_scale: benchmark.x_scale === "log" ? "log" : "linear",
        y_scale: benchmark.y_scale === "log" ? "log" : "linear",
        simulation: benchmark.simulation,
      },
    ]
  })
}

export async function readBenchmarkRecords(model_dir: string): Promise<BenchmarkPreviewRecord[]> {
  for (const file_name of ["benchmarks.json", "benchmark-draft.json"]) {
    const value = await readFile(join(model_dir, file_name), "utf8")
      .then((text) => JSON.parse(text))
      .catch(() => undefined)
    const benchmarks = parseBenchmarks(value)
    if (benchmarks.length > 0) return benchmarks
  }
  return []
}

function downsampleCurvePoints(points: ModelCurvePoint[]): ModelCurvePoint[] {
  if (points.length <= 600) return points
  const stride = Math.ceil(points.length / 600)
  return points.filter((_, index) => index % stride === 0 || index === points.length - 1)
}

function parseCurveCsv(text: string): ModelCurvePoint[] {
  return downsampleCurvePoints(
    text
      .split(/\r?\n/)
      .slice(1)
      .flatMap((line) => {
        const [raw_x, raw_y] = line.split(",")
        const x = Number(raw_x?.trim())
        const y = Number(raw_y?.trim())
        return Number.isFinite(x) && Number.isFinite(y) ? [{ x, y }] : []
      }),
  )
}

export async function listFiles(directory: string, suffix: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entry_path = join(directory, entry.name)
      if (entry.isDirectory()) return listFiles(entry_path, suffix)
      return entry.name.endsWith(suffix) ? [entry_path] : []
    }),
  )
  return nested.flat()
}

export async function newestFile(files: string[]): Promise<string | undefined> {
  const dated = await Promise.all(
    files.map(async (file) => ({
      file,
      modified_at: (await stat(file).catch(() => undefined))?.mtimeMs ?? 0,
    })),
  )
  return dated.sort((first, second) => second.modified_at - first.modified_at)[0]?.file
}

export async function readReferencePreview(input: {
  model_dir: string
  current_benchmark?: string
  require_exact?: boolean
  circuit_preview?: ModelCircuitPreview
}): Promise<ModelReferencePreview | undefined> {
  const benchmarks = await readBenchmarkRecords(input.model_dir)
  const normalized_current = input.current_benchmark?.replace(/\.circuit\.tsx$/i, "")
  let selected = benchmarks.find(
    (benchmark) =>
      benchmark.id === normalized_current ||
      benchmark.reference_file?.includes(normalized_current ?? "\u0000"),
  )
  if (input.require_exact && !selected) return undefined
  selected ??= benchmarks.find((benchmark) => Boolean(benchmark.reference_file))

  let reference_file = selected?.reference_file
  if (!reference_file) {
    const newest_curve = await newestFile(
      await listFiles(join(input.model_dir, "evidence", "curves"), ".csv"),
    )
    if (!newest_curve) return undefined
    reference_file = relative(input.model_dir, newest_curve)
    selected = { id: basename(reference_file, ".csv"), title: basename(reference_file, ".csv") }
  }

  const reference_path = join(input.model_dir, reference_file)
  const [reference_text, reference_stat] = await Promise.all([
    readFile(reference_path, "utf8").catch(() => undefined),
    stat(reference_path).catch(() => undefined),
  ])
  if (!reference_text) return undefined
  const reference_points = parseCurveCsv(reference_text)
  if (reference_points.length === 0) return undefined

  const result_points = (() => {
    if (!input.circuit_preview?.circuit_json || !selected?.simulation) return undefined
    try {
      return downsampleCurvePoints(
        extractSimulationResultPoints(
          input.circuit_preview.circuit_json,
          parseSimulationDefinition(selected.simulation),
        ),
      )
    } catch {
      return undefined
    }
  })()
  const is_stale = Boolean(input.circuit_preview?.is_stale)
  const result_origin = result_points?.length ? input.circuit_preview?.snapshot_origin : undefined
  const result_status = result_points?.length
    ? is_stale
      ? "deprecated"
      : result_origin === "workspace"
        ? "unverified"
        : input.circuit_preview?.build_status === "ready"
          ? "verified"
          : input.circuit_preview?.build_status === "building"
            ? "partial"
            : "unverified"
    : undefined
  return {
    benchmark_id: selected?.id,
    title: selected?.title ?? selected?.id ?? basename(reference_file, ".csv"),
    source_file: reference_file,
    result_file:
      result_status === "verified" && selected?.id ? `results/verified/${selected.id}.csv` : undefined,
    x_scale: selected?.x_scale === "log" ? "log" : "linear",
    y_scale: selected?.y_scale === "log" ? "log" : "linear",
    reference_points,
    result_points: result_points && result_points.length > 0 ? result_points : undefined,
    result_status,
    result_origin,
    is_stale,
    updated_at:
      (result_points?.length ? input.circuit_preview?.updated_at : undefined) ??
      reference_stat?.mtime.toISOString() ??
      new Date().toISOString(),
  }
}
