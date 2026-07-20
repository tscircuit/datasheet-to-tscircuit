import { mkdir, readFile, readdir, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { parseBenchmarkManifest, validateBenchmarkReferenceFiles } from "../model-scorer"
import { validateSimulationDefinitions } from "../model-simulation-validator"
import { BenchmarkLock, LockedFile } from "./types"
import { assertBenchmarkSourceContract, parseBenchmarkRecords } from "./assert-benchmark-source-contract"
import {
  assertEvidenceFile,
  getLockRoot,
  hashText,
  isRecord,
  resolveWorkspaceFile,
} from "./benchmark-lock-paths"

export async function readCurrentLock(model_dir: string): Promise<{
  benchmark_ids: string[]
  files: Array<LockedFile & { text: string }>
}> {
  const manifest_text = await readFile(join(model_dir, "benchmarks.json"), "utf8")
  const manifest_value: unknown = JSON.parse(manifest_text)
  const manifest = parseBenchmarkManifest(manifest_value)
  const records = parseBenchmarkRecords(manifest_value)
  for (const record of records) assertEvidenceFile(model_dir, record.reference_file)
  await validateBenchmarkReferenceFiles(model_dir, manifest)
  await validateSimulationDefinitions(
    model_dir,
    records.map((record) => record.id),
  )
  const benchmark_entries = await readdir(join(model_dir, "benchmarks")).catch(() => [])
  const benchmark_files = benchmark_entries.filter((entry) => entry.endsWith(".circuit.tsx")).sort()
  const expected_files = records.map((record) => `${record.id}.circuit.tsx`).sort()
  if (JSON.stringify(benchmark_files) !== JSON.stringify(expected_files)) {
    throw new Error("benchmarks.json and benchmarks/*.circuit.tsx must contain the same locked benchmark ids")
  }

  const paths = [
    "benchmarks.json",
    ...records.map((record) => join("benchmarks", `${record.id}.circuit.tsx`)),
    ...records.map((record) => record.reference_file),
  ]
  const unique_paths = [...new Set(paths)]
  const files = await Promise.all(
    unique_paths.map(async (file) => {
      const text = await readFile(resolveWorkspaceFile(model_dir, file), "utf8")
      return { file, text, sha256: hashText(text) }
    }),
  )
  for (const record of records) {
    const source = files.find((file) => file.file === join("benchmarks", `${record.id}.circuit.tsx`))?.text
    if (!source) throw new Error(`Benchmark ${record.id} source is missing`)
    assertBenchmarkSourceContract(source, record)
  }
  return { benchmark_ids: records.map((record) => record.id).sort(), files }
}

export async function writeTextAtomically(file_path: string, text: string): Promise<void> {
  await mkdir(dirname(file_path), { recursive: true })
  const temporary_path = `${file_path}.${crypto.randomUUID()}.tmp`
  await Bun.write(temporary_path, text)
  await rename(temporary_path, file_path)
}

export function parseLock(value: unknown): BenchmarkLock {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.locked_at !== "string" ||
    !Array.isArray(value.benchmark_ids) ||
    !value.benchmark_ids.every((id) => typeof id === "string") ||
    !Array.isArray(value.files) ||
    !value.files.every(
      (file) => isRecord(file) && typeof file.file === "string" && typeof file.sha256 === "string",
    )
  ) {
    throw new Error("The server-owned benchmark lock is invalid")
  }
  const generation = "generation" in value ? value.generation : 1
  if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 1) {
    throw new Error("The server-owned benchmark lock has an invalid generation")
  }
  return { ...(value as Omit<BenchmarkLock, "generation">), generation }
}

export async function writeLockSnapshots(input: {
  model_dir: string
  files: Array<LockedFile & { text: string }>
  generation: number
}): Promise<void> {
  const { model_dir, files, generation } = input
  const lock_root = getLockRoot(model_dir)
  const generation_root = join(lock_root, "snapshots", `generation-${String(generation).padStart(4, "0")}`)
  const current_root = join(lock_root, "snapshot")
  await rm(current_root, { recursive: true, force: true })
  await Promise.all(
    files.flatMap(({ file, text }) => [
      writeTextAtomically(join(generation_root, file), text),
      writeTextAtomically(join(current_root, file), text),
    ]),
  )
}
