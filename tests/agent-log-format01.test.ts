import { expect, test } from "bun:test"
import type { JobLog, JobLogStream } from "@/shared/job-types"
import { formatAgentLogs, stripTerminalControlSequences } from "@/web/agent-log-format"

function log(log_id: string, stream: JobLogStream, message: string): JobLog {
  return { log_id, stream, message, created_at: "2026-07-16T17:14:00.000Z" }
}

test("terminal styling is removed before logs are displayed", () => {
  expect(stripTerminalControlSequences("\u001b[0m\u001b[31m[tool] bash ok\u001b[0m\r\n")).toBe(
    "[tool] bash ok\n",
  )
})

test("agent terminal output becomes structured presentation entries", () => {
  const entries = formatAgentLogs([
    log("1", "system", "Starting agent…\n"),
    log("2", "stderr", "\u001b[31m[agent] start\u001b[0m\n[turn] start\n"),
    log("3", "stderr", "Checking the package drawing. "),
    log("4", "stderr", "The pinout is on page 3.\n"),
    log("5", "stderr", '\n[tool] bash {"command":"tsci build index.circuit.tsx"}\n'),
    log("6", "stderr", "[tool] bash ok\n"),
    log("7", "stdout", "Mapped all "),
    log("8", "stdout", "eight pins.\n"),
    log("9", "stderr", "[turn] end\n[agent] done\n"),
    log("10", "stderr", "Build warning\n"),
  ])

  expect(entries.map((entry) => entry.kind)).toEqual(["system", "reasoning", "tool", "message", "error"])
  expect(entries[1]).toMatchObject({
    kind: "reasoning",
    text: "Checking the package drawing. The pinout is on page 3.\n\n",
  })
  expect(entries[2]).toMatchObject({
    kind: "tool",
    title: "Run command",
    summary: "tsci build index.circuit.tsx",
    status: "ok",
  })
  expect(entries[3]).toMatchObject({ kind: "message", text: "Mapped all eight pins.\n" })
  expect(JSON.stringify(entries)).not.toContain("[turn]")
  expect(JSON.stringify(entries)).not.toContain("\u001b")
})
