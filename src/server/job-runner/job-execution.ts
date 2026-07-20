import type { JobLogStream, JobValidation } from "@/shared/job-types"
import type { JobRunnerContext } from "./stream-job-process"

export type JobValidationPhase = "evidence" | "component_generation" | "application_generation"

export class JobExecution {
  readonly job_id: string
  readonly additional_instructions?: string
  readonly job_dir: string
  readonly cancellation_signal: AbortSignal
  readonly context: JobRunnerContext
  readonly protected_event_log_file: string
  readonly published_event_log_file: string
  active_validation_phase: JobValidationPhase = "evidence"
  validation: JobValidation = {
    evidence: "pending",
    component_build: "pending",
    component_drc: "pending",
    footprint: "pending",
    pinout: "pending",
    component_schematic: "pending",
    component_visual: "pending",
    application_build: "pending",
    application_connectivity: "pending",
    application_schematic: "pending",
    application_visual: "pending",
  }

  constructor(input: {
    job_id: string
    additional_instructions?: string
    job_dir: string
    cancellation_signal: AbortSignal
    context: JobRunnerContext
    protected_event_log_file: string
    published_event_log_file: string
  }) {
    this.job_id = input.job_id
    this.additional_instructions = input.additional_instructions
    this.job_dir = input.job_dir
    this.cancellation_signal = input.cancellation_signal
    this.context = input.context
    this.protected_event_log_file = input.protected_event_log_file
    this.published_event_log_file = input.published_event_log_file
  }

  async append(stream: JobLogStream, message: string): Promise<void> {
    await this.context.job_store.appendLog(this.job_id, { stream, message })
  }

  updateValidation(update: Partial<JobValidation>): void {
    this.validation = { ...this.validation, ...update }
    this.context.job_store.updateJob(this.job_id, { validation: this.validation })
  }
}
