import type { ModelCircuitPreview, ModelProgress, ModelReferencePreview } from "@/shared/job-types"
import { parseModelProgress } from "../model-progress"
import { isRecord } from "./read-persisted-logs"

export function parseRestoredModelProgress(value: unknown): ModelProgress | undefined {
  try {
    return parseModelProgress(value)
  } catch {
    return undefined
  }
}

export function isModelCircuitPreview(value: unknown): value is ModelCircuitPreview {
  return (
    isRecord(value) &&
    typeof value.source_file === "string" &&
    typeof value.code === "string" &&
    (value.build_status === "source_ready" ||
      value.build_status === "building" ||
      value.build_status === "ready" ||
      value.build_status === "failed") &&
    typeof value.updated_at === "string"
  )
}

export function isModelReferencePreview(value: unknown): value is ModelReferencePreview {
  return (
    isRecord(value) &&
    typeof value.title === "string" &&
    typeof value.source_file === "string" &&
    (value.x_scale === "linear" || value.x_scale === "log") &&
    (value.y_scale === "linear" || value.y_scale === "log") &&
    Array.isArray(value.reference_points) &&
    typeof value.updated_at === "string"
  )
}
