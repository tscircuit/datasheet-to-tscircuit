import type { JobStore } from "../job-store"
import type { ModelRunStore } from "../model-run-store"

interface JobCompletionWaitInput {
  job_id: string
  timeout_ms?: number
}

export function waitForJobCompletion(
  { job_id, timeout_ms = 5_000 }: JobCompletionWaitInput,
  job_store: JobStore,
): Promise<boolean> {
  if (job_store.getJob(job_id)?.is_complete) return Promise.resolve(true)

  return new Promise((resolve) => {
    let unsubscribe: (() => void) | undefined
    const finish = (is_complete: boolean) => {
      clearTimeout(timeout)
      unsubscribe?.()
      resolve(is_complete)
    }
    const timeout = setTimeout(() => finish(false), timeout_ms)
    unsubscribe = job_store.subscribe(job_id, (job_event) => {
      if (job_event.event_type !== "log" && job_event.job.is_complete) finish(true)
    })
    if (!unsubscribe) finish(false)
  })
}

interface ModelRunCompletionWaitInput {
  model_run_id: string
  timeout_ms?: number
}

export function waitForModelRunCompletion(
  { model_run_id, timeout_ms = 5_000 }: ModelRunCompletionWaitInput,
  model_run_store: ModelRunStore,
): Promise<boolean> {
  if (model_run_store.getModelRun(model_run_id)?.is_complete) return Promise.resolve(true)

  return new Promise((resolve) => {
    let unsubscribe: (() => void) | undefined
    const finish = (is_complete: boolean) => {
      clearTimeout(timeout)
      unsubscribe?.()
      resolve(is_complete)
    }
    const timeout = setTimeout(() => finish(false), timeout_ms)
    unsubscribe = model_run_store.subscribe(model_run_id, (event) => {
      if (event.event_type !== "log" && event.model_run.is_complete) finish(true)
    })
    if (!unsubscribe) finish(false)
  })
}
