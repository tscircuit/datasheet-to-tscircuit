import { type TrustedAgentEvent } from "../agent-event-protocol"
import { StreamProcessInput } from "./stream-job-process"

export function stringifyForLog(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export async function renderTrustedAgentEvent(
  event: TrustedAgentEvent,
  append: StreamProcessInput["on_chunk"],
): Promise<void> {
  if (event.type === "text_delta") return append("stdout", event.text)
  if (event.type === "thinking_delta") return append("stderr", event.text)
  if (event.type === "tool_start") {
    return append("stderr", `\n[tool] ${event.tool_name} ${stringifyForLog(event.args)}\n`)
  }
  if (event.type === "tool_end") {
    return append("stderr", `[tool] ${event.tool_name} ${event.is_error ? "failed" : "ok"}\n`)
  }
  if (event.type === "agent_end") {
    return append("stderr", event.failed ? "\n[agent] failed\n" : "\n[agent] done\n")
  }
}
