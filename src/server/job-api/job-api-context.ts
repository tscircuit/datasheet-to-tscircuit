import { runJob, type JobRunnerContext } from "../job-runner"
import { runModel } from "../model-runner"
import type { ModelRunStore } from "../model-run-store"

export const MAX_PDF_BYTES = 30 * 1024 * 1024

export interface JobApiContext extends JobRunnerContext {
  jobs_root: string
  run_job?: typeof runJob
  model_run_store?: ModelRunStore
  run_model?: typeof runModel
  model_base_effort_ms?: number
}
