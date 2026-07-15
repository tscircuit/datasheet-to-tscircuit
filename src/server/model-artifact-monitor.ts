import { createHash } from "node:crypto"
import { readdir, readFile, stat } from "node:fs/promises"
import { basename, dirname, join, relative } from "node:path"
import type {
  ModelCircuitPreview,
  ModelCurvePoint,
  ModelPreviewOption,
  ModelReferencePreview,
  ModelSelectedPreview,
} from "@/shared/job-types"
import type { ModelRunStore } from "./model-run-store"
import { getVerifiedResultFile } from "./model-simulation-validator"

interface BenchmarkPreviewRecord {
  id?: string
  title?: string
  reference_file?: string
  result_file?: string
  x_scale?: string
  y_scale?: string
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
        result_file: typeof benchmark.result_file === "string" ? benchmark.result_file : undefined,
        x_scale: benchmark.x_scale === "log" ? "log" : "linear",
        y_scale: benchmark.y_scale === "log" ? "log" : "linear",
      },
    ]
  })
}

async function readBenchmarkRecords(model_dir: string): Promise<BenchmarkPreviewRecord[]> {
  for (const file_name of ["benchmarks.json", "benchmark-draft.json"]) {
    const value = await readFile(join(model_dir, file_name), "utf8")
      .then((text) => JSON.parse(text) as unknown)
      .catch(() => undefined)
    const benchmarks = parseBenchmarks(value)
    if (benchmarks.length > 0) return benchmarks
  }
  return []
}

function parseCurveCsv(text: string): ModelCurvePoint[] {
  const points = text
    .split(/\r?\n/)
    .slice(1)
    .flatMap((line) => {
      const [raw_x, raw_y] = line.split(",")
      const x = Number(raw_x?.trim())
      const y = Number(raw_y?.trim())
      return Number.isFinite(x) && Number.isFinite(y) ? [{ x, y }] : []
    })
  if (points.length <= 600) return points
  const stride = Math.ceil(points.length / 600)
  return points.filter((_, index) => index % stride === 0 || index === points.length - 1)
}

async function listFiles(directory: string, suffix: string): Promise<string[]> {
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

async function newestFile(files: string[]): Promise<string | undefined> {
  const dated = await Promise.all(
    files.map(async (file) => ({
      file,
      modified_at: (await stat(file).catch(() => undefined))?.mtimeMs ?? 0,
    })),
  )
  return dated.sort((first, second) => second.modified_at - first.modified_at)[0]?.file
}

async function readReferencePreview(input: {
  model_dir: string
  current_benchmark?: string
  require_exact?: boolean
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

  const reference_text = await readFile(join(input.model_dir, reference_file), "utf8").catch(() => undefined)
  if (!reference_text) return undefined
  const reference_points = parseCurveCsv(reference_text)
  if (reference_points.length === 0) return undefined

  const verified_result_file = selected?.id
    ? await getVerifiedResultFile(input.model_dir, selected.id).catch(() => undefined)
    : undefined
  const result_text = verified_result_file
    ? await readFile(join(input.model_dir, verified_result_file), "utf8").catch(() => undefined)
    : undefined
  const result_points = result_text ? parseCurveCsv(result_text) : undefined
  return {
    benchmark_id: selected?.id,
    title: selected?.title ?? selected?.id ?? basename(reference_file, ".csv"),
    source_file: reference_file,
    result_file: verified_result_file,
    x_scale: selected?.x_scale === "log" ? "log" : "linear",
    y_scale: selected?.y_scale === "log" ? "log" : "linear",
    reference_points,
    result_points: result_points && result_points.length > 0 ? result_points : undefined,
    updated_at: new Date().toISOString(),
  }
}

async function selectCircuitSource(input: {
  model_dir: string
  current_benchmark?: string
  require_exact?: boolean
}): Promise<string | undefined> {
  const benchmark_files = await listFiles(join(input.model_dir, "benchmarks"), ".circuit.tsx")
  const normalized_current = input.current_benchmark?.replace(/\.circuit\.tsx$/i, "")
  const current_file = benchmark_files.find((file) => basename(file, ".circuit.tsx") === normalized_current)
  if (current_file) return current_file
  if (input.require_exact) return undefined
  const newest_benchmark = await newestFile(benchmark_files)
  if (newest_benchmark) return newest_benchmark
  const component_file = join(input.model_dir, "component-with-model.circuit.tsx")
  return Bun.file(component_file).size > 0 ? component_file : undefined
}

function isCircuitJson(value: unknown): value is ModelCircuitPreview["circuit_json"] {
  return (
    Array.isArray(value) &&
    value.every(
      (element) => typeof element === "object" && element !== null && typeof element.type === "string",
    )
  )
}

async function buildCircuitPreview(input: {
  source_path: string
  source_file: string
  code: string
  model_dir: string
  tsci_bin: string
}): Promise<ModelCircuitPreview> {
  const job_dir = dirname(input.model_dir)
  const output_relative = relative(job_dir, input.source_path).replace(/\.circuit\.tsx$/i, "")
  const output_file = join(job_dir, "dist", output_relative, "circuit.json")
  const child = Bun.spawn(
    [input.tsci_bin, "build", input.source_path, "--ignore-errors", "--ignore-warnings"],
    {
      cwd: input.model_dir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [exit_code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  const parsed = await readFile(output_file, "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => undefined)
  if (exit_code === 0 && isCircuitJson(parsed)) {
    return {
      source_file: input.source_file,
      code: input.code,
      build_status: "ready",
      circuit_json: parsed,
      updated_at: new Date().toISOString(),
    }
  }
  const output = `${stderr}\n${stdout}`.trim().slice(-1_000)
  return {
    source_file: input.source_file,
    code: input.code,
    build_status: "failed",
    error_message: output || `tsci build exited with code ${exit_code} without Circuit JSON`,
    updated_at: new Date().toISOString(),
  }
}

async function getCircuitDependencySignature(input: {
  model_dir: string
  source_file: string
  code: string
}): Promise<string> {
  const dependency_files = ["model.lib", "component-with-model.circuit.tsx", "component.circuit.tsx"]
  const dependencies = await Promise.all(
    dependency_files.map(async (file_name) => ({
      file_name,
      text: await readFile(join(input.model_dir, file_name), "utf8").catch(() => ""),
    })),
  )
  const hash = createHash("sha256")
  hash.update(input.source_file)
  hash.update("\0")
  hash.update(input.code)
  for (const dependency of dependencies) {
    hash.update("\0")
    hash.update(dependency.file_name)
    hash.update("\0")
    hash.update(dependency.text)
  }
  return hash.digest("hex")
}

export async function listModelPreviewOptions(model_dir: string): Promise<ModelPreviewOption[]> {
  const [benchmarks, benchmark_files] = await Promise.all([
    readBenchmarkRecords(model_dir),
    listFiles(join(model_dir, "benchmarks"), ".circuit.tsx"),
  ])
  return (
    await Promise.all(
      benchmark_files.map(async (file) => {
        const benchmark_id = basename(file, ".circuit.tsx")
        const benchmark = benchmarks.find((candidate) => candidate.id === benchmark_id)
        return {
          benchmark_id,
          title: benchmark?.title ?? benchmark_id,
          circuit_file: relative(model_dir, file),
          reference_file: benchmark?.reference_file,
          result_file: await getVerifiedResultFile(model_dir, benchmark_id).catch(() => undefined),
        }
      }),
    )
  ).sort((first, second) => first.title.localeCompare(second.title))
}

const selected_preview_cache = new Map<string, { signature: string; promise: Promise<ModelCircuitPreview> }>()

export async function loadModelSelectedPreview(input: {
  model_dir: string
  tsci_bin: string
  benchmark_id: string
}): Promise<ModelSelectedPreview | undefined> {
  const source_path = await selectCircuitSource({
    model_dir: input.model_dir,
    current_benchmark: input.benchmark_id,
    require_exact: true,
  })
  if (!source_path) return undefined
  const code = await readFile(source_path, "utf8").catch(() => undefined)
  if (!code) return undefined
  const source_file = relative(input.model_dir, source_path)
  const cache_key = `${input.model_dir}\u0000${input.benchmark_id}`
  const signature = await getCircuitDependencySignature({
    model_dir: input.model_dir,
    source_file,
    code,
  })
  let cached = selected_preview_cache.get(cache_key)
  if (!cached || cached.signature !== signature) {
    cached = {
      signature,
      promise: buildCircuitPreview({
        source_path,
        source_file,
        code,
        model_dir: input.model_dir,
        tsci_bin: input.tsci_bin,
      }),
    }
    selected_preview_cache.set(cache_key, cached)
  }
  const [circuit_preview, reference_preview] = await Promise.all([
    cached.promise,
    readReferencePreview({
      model_dir: input.model_dir,
      current_benchmark: input.benchmark_id,
      require_exact: true,
    }),
  ])
  return { circuit_preview, reference_preview }
}

export interface ModelArtifactMonitor {
  sync: () => Promise<void>
  stop: () => void
}

export function startModelArtifactMonitor(input: {
  model_run_id: string
  model_dir: string
  model_run_store: ModelRunStore
  tsci_bin: string
  interval_ms?: number
}): ModelArtifactMonitor {
  let is_stopped = false
  let sync_in_flight: Promise<void> | undefined
  let reference_signature: string | undefined
  let circuit_signature: string | undefined

  const sync = async () => {
    if (is_stopped) return
    if (sync_in_flight) return sync_in_flight
    sync_in_flight = (async () => {
      const current_run = input.model_run_store.getModelRun(input.model_run_id)
      const current_benchmark = current_run?.progress?.benchmark?.current
      const preview_options = await listModelPreviewOptions(input.model_dir)
      input.model_run_store.updatePreviewOptions(input.model_run_id, preview_options)
      const reference_preview = await readReferencePreview({
        model_dir: input.model_dir,
        current_benchmark,
      })
      if (reference_preview) {
        const signature = JSON.stringify({ ...reference_preview, updated_at: undefined })
        if (signature !== reference_signature) {
          reference_signature = signature
          input.model_run_store.updateReferencePreview(input.model_run_id, reference_preview)
        }
      }

      const source_path = await selectCircuitSource({ model_dir: input.model_dir, current_benchmark })
      if (!source_path) return
      const code = await readFile(source_path, "utf8").catch(() => undefined)
      if (!code) return
      const source_file = relative(input.model_dir, source_path)
      const signature = await getCircuitDependencySignature({
        model_dir: input.model_dir,
        source_file,
        code,
      })
      if (signature === circuit_signature) return
      circuit_signature = signature
      input.model_run_store.updateCircuitPreview(input.model_run_id, {
        source_file,
        code,
        build_status: "building",
        updated_at: new Date().toISOString(),
      })
      const preview = await buildCircuitPreview({
        source_path,
        source_file,
        code,
        model_dir: input.model_dir,
        tsci_bin: input.tsci_bin,
      })
      if (input.model_run_store.getModelRun(input.model_run_id)) {
        input.model_run_store.updateCircuitPreview(input.model_run_id, preview)
      }
    })()
    try {
      await sync_in_flight
    } finally {
      sync_in_flight = undefined
    }
  }

  const timer = setInterval(() => void sync(), input.interval_ms ?? 750)
  void sync()
  return {
    sync,
    stop: () => {
      is_stopped = true
      clearInterval(timer)
    },
  }
}
