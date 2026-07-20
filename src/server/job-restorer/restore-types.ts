import type { JobDisplayStatus, ModelRunStatus } from "@/shared/job-types"

export const JOB_STATUSES = new Set<JobDisplayStatus>([
  "queued",
  "agent_running",
  "building",
  "cancelling",
  "cancelled",
  "complete",
  "unsupported",
  "failed",
])

export const ACTIVE_JOB_STATUSES = new Set<JobDisplayStatus>([
  "queued",
  "agent_running",
  "building",
  "cancelling",
])

export const OBSOLETE_LAYOUT_FAILURE_PREFIX = "Typical application failed schematic layout validation:"

export const LAYOUT_RECOVERY_LOG =
  "Recovered the generated typical application: the former wire-length compactness gate was advisory, and the saved build, image inspection, values, and connectivity all passed.\n"

export const MODEL_STATUSES = new Set<ModelRunStatus>([
  "queued",
  "setting_up",
  "waiting_for_component",
  "running",
  "validating",
  "cancelling",
  "cancelled",
  "complete",
  "timed_out",
  "failed",
])
