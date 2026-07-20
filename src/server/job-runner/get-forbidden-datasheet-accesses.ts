import { join } from "node:path"
import { type TrustedAgentEvent } from "../agent-event-protocol"
import { stringifyForLog } from "./render-trusted-agent-event"

export function getForbiddenDatasheetAccesses(events: TrustedAgentEvent[]): string[] {
  const blocked = /(?:^|["'/\\])datasheet\.(?:pdf|txt)\b|\b(?:pdftotext|pdfinfo|pdftoppm|mutool|qpdf)\b/i
  return events.flatMap((event) => {
    if (event.type !== "tool_start") return []
    if (event.tool_name === "write") return []
    let args = stringifyForLog(event.args)
    if (event.tool_name === "bash") {
      // A workspace inventory may explicitly exclude the absent locked inputs.
      // Remove only negative find predicates; any actual read elsewhere in the
      // same command remains and is still detected by the expression above.
      args = args.replace(
        /(?:!\s*|-not\s+)-(?:name|path)\s+(?:"datasheet\.(?:pdf|txt)"|'datasheet\.(?:pdf|txt)'|datasheet\.(?:pdf|txt))/gi,
        "",
      )
    }
    return blocked.test(args) ? [`${event.tool_name} ${args}`] : []
  })
}

export function assertNoDatasheetAccess(events: TrustedAgentEvent[], phase: string): void {
  const accesses = getForbiddenDatasheetAccesses(events)
  if (accesses.length > 0) {
    throw new Error(
      `${phase} accessed locked datasheet inputs after evidence approval: ${accesses.join("; ")}`,
    )
  }
}
