import { readFile, stat } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import type { ModelCircuitPreview } from "@/shared/job-types"
import {
  getModelSimulationSourceSignature,
  getSimulationBenchmarkVerification,
  getVerifiedSimulationArtifact,
} from "../model-simulation-validator"
import { listFiles, newestFile, readBenchmarkRecords } from "./read-reference-preview"

export async function selectCircuitSource(input: {
  model_dir: string
  current_benchmark?: string
  require_exact?: boolean
}): Promise<string | undefined> {
  const benchmarks = await readBenchmarkRecords(input.model_dir)
  const declared_ids = benchmarks.flatMap((benchmark) =>
    typeof benchmark.id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(benchmark.id)
      ? [benchmark.id]
      : [],
  )
  const normalized_current = input.current_benchmark?.replace(/\.circuit\.tsx$/i, "")
  if (normalized_current && declared_ids.includes(normalized_current)) {
    const current_file = join(input.model_dir, "benchmarks", `${normalized_current}.circuit.tsx`)
    if ((await stat(current_file).catch(() => undefined))?.isFile()) return current_file
  }
  if (input.require_exact) return undefined
  const benchmark_files = declared_ids.map((id) => join(input.model_dir, "benchmarks", `${id}.circuit.tsx`))
  const existing_files = (
    await Promise.all(
      benchmark_files.map(async (file) =>
        (await stat(file).catch(() => undefined))?.isFile() ? file : undefined,
      ),
    )
  ).filter((file): file is string => Boolean(file))
  const newest_benchmark = await newestFile(existing_files)
  if (newest_benchmark) return newest_benchmark
  const component_file = join(input.model_dir, "component-with-model.circuit.tsx")
  return Bun.file(component_file).size > 0 ? component_file : undefined
}

function isCircuitJson(value: unknown): value is NonNullable<ModelCircuitPreview["circuit_json"]> {
  return (
    Array.isArray(value) &&
    value.every(
      (element) => typeof element === "object" && element !== null && typeof element.type === "string",
    )
  )
}

function containsServerBenchmarkStub(
  circuit_json: NonNullable<ModelCircuitPreview["circuit_json"]>,
): boolean {
  return circuit_json.some((element) => {
    if (element.type !== "simulation_spice_subcircuit") return false
    const source = (element as { subcircuit_source?: unknown }).subcircuit_source
    return typeof source === "string" && /\bSERVER_BENCHMARK_STUB\b/.test(source)
  })
}

async function readWorkspaceCircuitJson(input: {
  model_dir: string
  benchmark_id: string
}): Promise<
  { circuit_json: NonNullable<ModelCircuitPreview["circuit_json"]>; updated_at: string } | undefined
> {
  const dist_root = join(dirname(input.model_dir), "dist", "spice")
  const canonical_file = join(dist_root, "benchmarks", input.benchmark_id, "circuit.json")
  const isolated_files = (
    await Promise.all([
      listFiles(join(input.model_dir, "validation-artifacts", input.benchmark_id, "runs"), "circuit.json"),
    ])
  ).flat()
  const candidates = [canonical_file, ...isolated_files]
  const dated = await Promise.all(
    candidates.map(async (file) => ({ file, file_stat: await stat(file).catch(() => undefined) })),
  )
  for (const candidate of dated.sort(
    (first, second) => (second.file_stat?.mtimeMs ?? 0) - (first.file_stat?.mtimeMs ?? 0),
  )) {
    if (!candidate.file_stat?.isFile()) continue
    const value = await readFile(candidate.file, "utf8")
      .then((text) => JSON.parse(text))
      .catch(() => undefined)
    if (isCircuitJson(value) && !containsServerBenchmarkStub(value)) {
      return { circuit_json: value, updated_at: candidate.file_stat.mtime.toISOString() }
    }
  }
  return undefined
}

export async function readPersistedCircuitPreview(input: {
  model_dir: string
  source_path: string
  benchmark_id: string
}): Promise<ModelCircuitPreview> {
  const [current_code, source_stat, current_signature, verified, workspace, verification] = await Promise.all(
    [
      readFile(input.source_path, "utf8"),
      stat(input.source_path),
      getModelSimulationSourceSignature(input.model_dir, input.benchmark_id),
      getVerifiedSimulationArtifact(input.model_dir, input.benchmark_id).catch(() => undefined),
      readWorkspaceCircuitJson(input),
      getSimulationBenchmarkVerification(input.model_dir, input.benchmark_id).catch(() => undefined),
    ],
  )
  const source_file = relative(input.model_dir, input.source_path)
  const verified_time = verified ? new Date(verified.generated_at).valueOf() : 0
  const workspace_time = workspace ? new Date(workspace.updated_at).valueOf() : 0
  const verification_time = verification ? new Date(verification.generated_at).valueOf() : 0
  const verification_status = verification?.status ?? (verification?.passed ? "passed" : "failed")
  const verification_is_current = Boolean(
    verification &&
      Number.isFinite(verification_time) &&
      verification_time >= source_stat.mtimeMs &&
      (!verification.source_signature || verification.source_signature === current_signature),
  )

  if (
    verification_is_current &&
    (verification_status === "building" ||
      (verification_status === "failed" && verification_time >= Math.max(verified_time, workspace_time)))
  ) {
    const state_circuit_json = verified?.circuit_json ?? workspace?.circuit_json
    return {
      source_file: verified?.source_file ?? source_file,
      code: verified?.code ?? current_code,
      build_status: verification_status,
      ...(state_circuit_json ? { circuit_json: state_circuit_json } : {}),
      ...(verified
        ? { snapshot_origin: "server_validation" as const }
        : workspace
          ? { snapshot_origin: "workspace" as const }
          : {}),
      error_message: verification_status === "failed" ? verification?.error_message : undefined,
      updated_at: workspace_time > verification_time ? workspace!.updated_at : verification!.generated_at,
    }
  }

  if (verified?.passed && verified_time >= workspace_time) {
    return {
      source_file: verified.source_file,
      code: verified.code,
      build_status: "ready",
      circuit_json: verified.circuit_json,
      snapshot_origin: "server_validation",
      is_stale: verified.source_signature !== current_signature,
      updated_at: verified.generated_at,
    }
  }
  if (workspace) {
    const dependency_files = [
      input.source_path,
      join(input.model_dir, "model.lib"),
      join(input.model_dir, "component-with-model.circuit.tsx"),
      join(input.model_dir, "component.circuit.tsx"),
    ]
    const dependency_stats = await Promise.all(
      dependency_files.map((file) => stat(file).catch(() => undefined)),
    )
    const newest_dependency = Math.max(...dependency_stats.map((value) => value?.mtimeMs ?? 0))
    return {
      source_file,
      code: current_code,
      build_status: "ready",
      circuit_json: workspace.circuit_json,
      snapshot_origin: "workspace",
      is_stale: workspace_time + 1 < newest_dependency,
      updated_at: workspace.updated_at,
    }
  }
  return {
    source_file,
    code: current_code,
    build_status: "source_ready",
    updated_at: source_stat.mtime.toISOString(),
  }
}
