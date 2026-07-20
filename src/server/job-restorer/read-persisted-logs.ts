import { readFile } from "node:fs/promises"
import type { JobLog } from "@/shared/job-types"

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export async function readJson(file_path: string): Promise<unknown> {
  return readFile(file_path, "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => undefined)
}

export async function readPersistedLogs(file_path: string): Promise<JobLog[]> {
  const text = await readFile(file_path, "utf8").catch(() => "")
  const expression = /^\[([^\]]+)] \[(system|stdout|stderr)] /gm
  const matches = [...text.matchAll(expression)]
  return matches.map((match, index) => {
    const message_start = (match.index ?? 0) + match[0].length
    const message_end = matches[index + 1]?.index ?? text.length
    return {
      log_id: `restored-${index}-${match[1]}`,
      created_at: match[1]!,
      stream: match[2] as JobLog["stream"],
      message: text.slice(message_start, message_end),
    }
  })
}
