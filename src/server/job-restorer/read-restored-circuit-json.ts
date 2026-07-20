import { join } from "node:path"
import type { Job, JobLog } from "@/shared/job-types"
import { readJson } from "./read-persisted-logs"

function isCircuitJson(value: unknown): value is Job["circuit_json"] {
  return (
    Array.isArray(value) &&
    value.every(
      (element) => typeof element === "object" && element !== null && typeof element.type === "string",
    )
  )
}

export async function readRestoredCircuitJson(
  job_dir: string,
  artifact: "component" | "typical_application",
): Promise<Job["circuit_json"] | undefined> {
  const candidates =
    artifact === "component"
      ? [
          join(job_dir, "dist", "spice", "component-with-model", "circuit.json"),
          join(job_dir, "dist", "index", "circuit.json"),
        ]
      : [join(job_dir, "dist", "typical-application", "circuit.json")]
  for (const candidate of candidates) {
    const value = await readJson(candidate)
    if (isCircuitJson(value)) return value
  }
  return undefined
}

export function inferFileName(logs: JobLog[], job_id: string): string {
  for (const log of logs) {
    const match = log.message.match(/Uploaded (.+) \(\d+ bytes\)\./)
    if (match?.[1]) return match[1]
  }
  return `${job_id}.pdf`
}
