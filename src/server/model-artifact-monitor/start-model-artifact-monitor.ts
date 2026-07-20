import type { ModelRunStore } from "../model-run-store"
import { listModelPreviewOptions, loadModelSelectedPreview } from "./model-preview-options"

export interface ModelArtifactMonitor {
  sync: () => Promise<void>
  stop: () => void
}

export function startModelArtifactMonitor(input: {
  model_run_id: string
  model_dir: string
  model_run_store: ModelRunStore
  interval_ms?: number
}): ModelArtifactMonitor {
  let is_stopped = false
  let sync_in_flight: Promise<void> | undefined
  let preview_signature: string | undefined

  const performSync = async () => {
    const current_run = input.model_run_store.getModelRun(input.model_run_id)
    const current_benchmark = current_run?.progress?.benchmark?.current
    const preview_options = await listModelPreviewOptions(input.model_dir)
    input.model_run_store.updatePreviewOptions(input.model_run_id, preview_options)
    const normalized_current = current_benchmark?.replace(/\.circuit\.tsx$/i, "")
    const benchmark_id = preview_options.some((option) => option.benchmark_id === normalized_current)
      ? normalized_current
      : preview_options[0]?.benchmark_id
    if (!benchmark_id) return
    const selected = await loadModelSelectedPreview({ model_dir: input.model_dir, benchmark_id })
    if (!selected) return

    const signature = JSON.stringify(selected)
    if (signature !== preview_signature) {
      preview_signature = signature
      input.model_run_store.updatePreviews(input.model_run_id, selected)
    }
  }

  const startSync = (): Promise<void> => {
    const running = (async () => {
      try {
        await performSync()
      } finally {
        sync_in_flight = undefined
      }
    })()
    sync_in_flight = running
    return running
  }

  const sync = async () => {
    if (is_stopped) return
    const active_sync = sync_in_flight
    if (active_sync) await active_sync
    if (is_stopped) return
    await (sync_in_flight ?? startSync())
  }

  const poll = () => {
    if (is_stopped || sync_in_flight) return
    void startSync()
  }

  const timer = setInterval(poll, input.interval_ms ?? 750)
  poll()
  return {
    sync,
    stop: () => {
      is_stopped = true
      clearInterval(timer)
    },
  }
}
