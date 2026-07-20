import { randomInt } from "node:crypto"
import { copyFile, readdir, readFile, rename, rm, stat } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import type { JobLogStream, ModelManifest } from "@/shared/job-types"
import type { ModelRunStore } from "../model-run-store"
import { isRecord, parseModelManifest, validateManifestAgainstModel } from "./parse-model-manifest"
import { writeServerIntegratedComponent } from "./attach-model-to-generated-component"
import { markModelRunCancelled } from "./model-run-state"

export async function readIterationCount(model_dir: string): Promise<number> {
  const value: unknown = JSON.parse(await readFile(join(model_dir, "iteration-history.json"), "utf8"))
  if (Array.isArray(value)) return value.length
  if (isRecord(value) && Array.isArray(value.iterations)) return value.iterations.length
  return 0
}

export async function listCandidateModelFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entry_path = join(directory, entry.name)
      if (entry.isDirectory()) return listCandidateModelFiles(entry_path)
      return /(?:^|[-_.])model\.lib$/i.test(entry.name) || /\.(?:lib|spice)$/i.test(entry.name)
        ? [entry_path]
        : []
    }),
  )
  return files.flat()
}

function findLastPromotedRevision(value: unknown): string | undefined {
  if (isRecord(value) && typeof value.champion_revision === "string" && value.champion_revision.trim()) {
    return value.champion_revision.trim()
  }
  const iterations = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.iterations)
      ? value.iterations
      : []
  return iterations
    .flatMap((iteration) => {
      if (!isRecord(iteration) || typeof iteration.revision !== "string") return []
      const decision = typeof iteration.decision === "string" ? iteration.decision.toLowerCase() : ""
      const status = typeof iteration.status === "string" ? iteration.status.toLowerCase() : ""
      const promotion_signal = `${status} ${decision}`
      return !promotion_signal.includes("not") && /promot|accept|champion|retain/.test(promotion_signal)
        ? [iteration.revision]
        : []
    })
    .at(-1)
}

async function writeTextAtomically(file_path: string, text: string): Promise<void> {
  const temporary_path = `${file_path}.${randomInt(1_000_000_000)}.tmp`
  try {
    await Bun.write(temporary_path, text)
    await rename(temporary_path, file_path)
  } finally {
    await rm(temporary_path, { force: true }).catch(() => undefined)
  }
}

export async function restoreLastPromotedModelCheckpoint(model_dir: string): Promise<string | undefined> {
  const history_file = join(model_dir, "iteration-history.json")
  const history_text = await readFile(history_file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  const history_value: unknown = history_text === undefined ? undefined : JSON.parse(history_text)
  const promoted_revision = findLastPromotedRevision(history_value)
  if (!promoted_revision) return undefined

  const manifest = await readFile(join(model_dir, "model-manifest.json"), "utf8")
    .then((text) => parseModelManifest(JSON.parse(text)))
    .catch(() => undefined)
  if (!manifest) {
    throw new Error(
      `Cannot restore promoted champion ${promoted_revision}: model-manifest.json is unavailable`,
    )
  }

  const canonical_file = join(model_dir, "model.lib")
  const candidate_files = await listCandidateModelFiles(join(model_dir, "candidates"))
  const promoted_file = candidate_files.find((file) => basename(dirname(file)) === promoted_revision)
  if (!promoted_file) {
    throw new Error(
      `Cannot restore promoted champion ${promoted_revision}: candidates/${promoted_revision}/model.lib is unavailable`,
    )
  }
  const promoted_source = await readFile(promoted_file, "utf8")

  const restored_manifest: ModelManifest = {
    ...manifest,
    revision: promoted_revision,
    generated_at: new Date().toISOString(),
  }
  validateManifestAgainstModel(restored_manifest, promoted_source)
  await writeTextAtomically(canonical_file, promoted_source)
  await writeTextAtomically(
    join(model_dir, "model-manifest.json"),
    `${JSON.stringify(restored_manifest, null, 2)}\n`,
  )
  await writeServerIntegratedComponent({
    model_dir,
    manifest: restored_manifest,
    model_source: promoted_source,
  })
  return promoted_revision
}

async function recoverBestModelFile(model_dir: string): Promise<string | undefined> {
  const canonical_file = join(model_dir, "model.lib")
  if (await Bun.file(canonical_file).exists()) return canonical_file

  const candidate_files = await listCandidateModelFiles(model_dir)
  if (candidate_files.length === 0) return undefined
  const history_value = await readFile(join(model_dir, "iteration-history.json"), "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => undefined)
  const promoted_revision = findLastPromotedRevision(history_value)
  const promoted_file = promoted_revision
    ? candidate_files.find((file) => file.includes(`/${promoted_revision}/`))
    : undefined
  const selected_file =
    promoted_file ??
    (
      await Promise.all(
        candidate_files.map(async (file) => ({
          file,
          modified_at: (await stat(file).catch(() => undefined))?.mtimeMs ?? 0,
        })),
      )
    ).sort((first, second) => second.modified_at - first.modified_at)[0]?.file
  if (!selected_file) return undefined
  await copyFile(selected_file, canonical_file)
  return canonical_file
}

export function markModelCardAsUnverified(model_card: string): string {
  const notice =
    "> **Server validation status:** This is an unverified checkpoint. It did not complete the locked independent benchmark suite.\n\n"
  return model_card.startsWith(notice) ? model_card : `${notice}${model_card}`
}

export async function preserveCheckpointAndMarkCancelled(input: {
  model_run_id: string
  model_dir: string
  model_run_store: ModelRunStore
  append: (stream: JobLogStream, message: string) => Promise<void>
}): Promise<void> {
  let restoration_failed = false
  const restored_revision = await restoreLastPromotedModelCheckpoint(input.model_dir).catch(async (error) => {
    restoration_failed = true
    await input
      .append(
        "system",
        `Could not safely restore the promoted cancellation checkpoint: ${
          error instanceof Error ? error.message : String(error)
        }. The newer workspace candidate was not published.\n`,
      )
      .catch(() => undefined)
    return undefined
  })
  if (restored_revision) {
    await input
      .append(
        "system",
        `Restored promoted champion ${restored_revision} as the canonical cancellation checkpoint.\n`,
      )
      .catch(() => undefined)
  }
  if (!restoration_failed) {
    await publishAvailableModelCheckpoint(
      { model_run_id: input.model_run_id, model_dir: input.model_dir },
      input.model_run_store,
    ).catch(() => false)
  }
  markModelRunCancelled(input.model_run_id, input.model_run_store)
}

export async function publishAvailableModelCheckpoint(
  input: { model_run_id: string; model_dir: string },
  model_run_store: ModelRunStore,
): Promise<boolean> {
  const { model_run_id, model_dir } = input
  const model_file = await recoverBestModelFile(model_dir)
  if (!model_file) return false
  const model_source = await readFile(model_file, "utf8")
  if (!/^\s*\.\s*subckt\b/im.test(model_source)) return false
  const manifest = await readFile(join(model_dir, "model-manifest.json"), "utf8")
    .then((text) => parseModelManifest(JSON.parse(text)))
    .catch(() => undefined)
  const model_card = await readFile(join(model_dir, "model-card.md"), "utf8").catch(() => undefined)
  const iteration = await readIterationCount(model_dir).catch(() => 0)
  model_run_store.updateModelRun(model_run_id, {
    model_source,
    ...(manifest ? { manifest } : {}),
    ...(model_card ? { model_card: markModelCardAsUnverified(model_card) } : {}),
    iteration,
  })
  return true
}
