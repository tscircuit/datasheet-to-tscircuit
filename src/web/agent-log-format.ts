import type { JobLog } from "@/shared/job-types"

export type AgentLogTextKind = "message" | "reasoning" | "system" | "output" | "error" | "notice"

export interface AgentLogTextEntry {
  entry_id: string
  kind: AgentLogTextKind
  text: string
}

export interface AgentLogToolEntry {
  entry_id: string
  kind: "tool"
  tool_name: string
  title: string
  summary?: string
  details?: string
  status: "running" | "ok" | "failed"
}

export type AgentLogEntry = AgentLogTextEntry | AgentLogToolEntry

const TOOL_TITLES: Record<string, string> = {
  apply_patch: "Edit files",
  bash: "Run command",
  edit: "Edit file",
  find: "Find text",
  glob: "Find files",
  read: "Read file",
  search: "Search",
  view: "View file",
  write: "Write file",
}

const OSC_SEQUENCE = new RegExp("\\u001B\\][^\\u0007]*(?:\\u0007|\\u001B\\\\)", "g")
const CSI_SEQUENCE = new RegExp("(?:\\u001B\\[|\\u009B)[0-?]*[ -/]*[@-~]", "g")
const ESCAPE_SEQUENCE = new RegExp("\\u001B[@-_]", "g")

/**
 * Removes terminal-only styling and control sequences from text before it is
 * placed in the DOM. The raw downloadable log remains untouched.
 */
export function stripTerminalControlSequences(value: string): string {
  return value
    .replace(OSC_SEQUENCE, "")
    .replace(CSI_SEQUENCE, "")
    .replace(ESCAPE_SEQUENCE, "")
    .replace(/\r\n?/g, "\n")
}

function titleCase(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase())
}

function truncate(value: string, maximum_length: number): string {
  const normalized = value.replace(/\s+/g, " ").trim()
  if (normalized.length <= maximum_length) return normalized
  return `${normalized.slice(0, maximum_length - 1).trimEnd()}…`
}

function getToolMetadata(
  tool_name: string,
  raw_arguments: string,
): Pick<AgentLogToolEntry, "summary" | "details"> {
  if (!raw_arguments) return {}

  let parsed_arguments: unknown
  try {
    parsed_arguments = JSON.parse(raw_arguments)
  } catch {
    return {
      summary: truncate(raw_arguments, 96),
      details: raw_arguments,
    }
  }

  const details = JSON.stringify(parsed_arguments, null, 2)
  if (typeof parsed_arguments !== "object" || parsed_arguments === null) {
    return { summary: truncate(String(parsed_arguments), 96), details }
  }

  const arguments_record = parsed_arguments as Record<string, unknown>
  const preferred_keys =
    tool_name === "bash"
      ? ["command", "cmd"]
      : ["path", "file_path", "query", "pattern", "url", "command", "cmd"]
  const summary_value = preferred_keys
    .map((key) => arguments_record[key])
    .find((value) => typeof value === "string" || Array.isArray(value))

  if (Array.isArray(summary_value)) {
    return { summary: truncate(summary_value.map(String).join(" "), 96), details }
  }
  if (typeof summary_value === "string") {
    return { summary: truncate(summary_value, 96), details }
  }

  const argument_count = Object.keys(arguments_record).length
  return {
    summary: argument_count === 1 ? "1 parameter" : `${argument_count} parameters`,
    details,
  }
}

function appendTextEntry(input: {
  entries: AgentLogEntry[]
  kind: AgentLogTextKind
  text: string
  entry_id: string
}): void {
  const { entries, kind, text, entry_id } = input
  const previous_entry = entries.at(-1)
  if (previous_entry?.kind === kind) {
    previous_entry.text += text
    return
  }
  if (!text.trim()) return
  entries.push({ entry_id, kind, text })
}

function completeToolEntry(input: {
  entries: AgentLogEntry[]
  tool_name: string
  status: AgentLogToolEntry["status"]
  entry_id: string
}): void {
  const { entries, tool_name, status, entry_id } = input
  const matching_entry = entries
    .slice()
    .reverse()
    .find(
      (entry): entry is AgentLogToolEntry =>
        entry.kind === "tool" && entry.tool_name === tool_name && entry.status === "running",
    )
  if (matching_entry) {
    matching_entry.status = status
    return
  }
  entries.push({
    entry_id,
    kind: "tool",
    tool_name,
    title: TOOL_TITLES[tool_name] ?? titleCase(tool_name),
    status,
  })
}

/**
 * Converts tsci-agent's human-readable terminal protocol into presentation
 * entries. It intentionally hides agent/turn framing markers while retaining
 * tool details in a form the UI can collapse.
 */
export function formatAgentLogs(logs: JobLog[]): AgentLogEntry[] {
  const entries: AgentLogEntry[] = []
  let is_agent_active = false

  for (const log of logs) {
    const clean_message = stripTerminalControlSequences(log.message)
    const lines = clean_message.match(/[^\n]*\n|[^\n]+/g) ?? []

    for (const [line_index, line] of lines.entries()) {
      const marker = line.trim()
      const entry_id = `${log.log_id}-${line_index}`
      const agent_marker = marker.match(/^\[agent\]\s+(start|done|failed)$/)
      if (agent_marker) {
        is_agent_active = agent_marker[1] === "start"
        continue
      }
      if (/^\[turn\]\s+(?:start|end)$/.test(marker)) continue

      const tool_marker = marker.match(/^\[tool\]\s+(\S+)(?:\s+([\s\S]*))?$/)
      if (tool_marker) {
        const tool_name = tool_marker[1] ?? "tool"
        const tool_payload = tool_marker[2]?.trim() ?? ""
        if (tool_payload === "ok" || tool_payload === "failed") {
          completeToolEntry({ entries, tool_name, status: tool_payload, entry_id })
        } else {
          entries.push({
            entry_id,
            kind: "tool",
            tool_name,
            title: TOOL_TITLES[tool_name] ?? titleCase(tool_name),
            ...getToolMetadata(tool_name, tool_payload),
            status: "running",
          })
        }
        continue
      }

      const operational_marker = marker.match(/^\[(compaction|retry)\]\s+(.+)$/)
      if (operational_marker) {
        appendTextEntry({
          entries,
          kind: "notice",
          text: `${titleCase(operational_marker[1] ?? "")}: ${operational_marker[2]}\n`,
          entry_id,
        })
        continue
      }

      const kind: AgentLogTextKind =
        log.stream === "system"
          ? "system"
          : log.stream === "stderr"
            ? is_agent_active
              ? "reasoning"
              : "error"
            : is_agent_active
              ? "message"
              : "output"
      appendTextEntry({ entries, kind, text: line, entry_id })
    }
  }

  return entries
}
