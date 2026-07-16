import { ChevronRight } from "lucide-react"
import { useEffect, useMemo, useRef } from "react"
import type { JobLog } from "@/shared/job-types"
import { formatAgentLogs } from "../agent-log-format"

function getToolStatusCopy(status: "running" | "ok" | "failed"): string {
  if (status === "ok") return "Done"
  if (status === "failed") return "Failed"
  return "Running"
}

function cleanDisplayText(value: string): string {
  return value
    .trim()
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
}

export function AgentLogViewer({
  logs,
  is_running,
  empty_message,
  className,
}: {
  logs: JobLog[]
  is_running: boolean
  empty_message: string
  className: string
}) {
  const scroll_ref = useRef<HTMLDivElement>(null)
  const entries = useMemo(() => formatAgentLogs(logs), [logs])

  useEffect(() => {
    const scroll_element = scroll_ref.current
    if (scroll_element && entries.length > 0) scroll_element.scrollTop = scroll_element.scrollHeight
  }, [entries])

  return (
    <div className={`${className} agent-log-viewer`} ref={scroll_ref} aria-live="polite">
      {entries.length === 0 ? <span className="terminal-muted">{empty_message}</span> : null}
      {entries.map((entry) => {
        if (entry.kind === "tool") {
          return (
            <details className={`agent-log-tool is-${entry.status}`} key={entry.entry_id}>
              <summary>
                <ChevronRight className="agent-log-chevron" size={13} />
                <i className="agent-log-status-dot" />
                <strong>{entry.title}</strong>
                {entry.summary ? <span>{entry.summary}</span> : null}
                <small>{getToolStatusCopy(entry.status)}</small>
              </summary>
              {entry.details ? <pre>{entry.details}</pre> : <p>No additional details.</p>}
            </details>
          )
        }

        const text = cleanDisplayText(entry.text)
        if (!text) return null

        if (entry.kind === "reasoning") {
          return (
            <details className="agent-log-reasoning" key={entry.entry_id}>
              <summary>
                <ChevronRight className="agent-log-chevron" size={13} />
                <span>Agent reasoning</span>
                <small>Hidden by default</small>
              </summary>
              <div>{text}</div>
            </details>
          )
        }

        if (entry.kind === "message") {
          return (
            <article className="agent-log-message" key={entry.entry_id}>
              <span>Agent</span>
              <div>{text}</div>
            </article>
          )
        }

        return (
          <div className={`agent-log-line agent-log-${entry.kind}`} key={entry.entry_id}>
            <i />
            <span>{text}</span>
          </div>
        )
      })}
      {is_running ? <span className="terminal-cursor" /> : null}
    </div>
  )
}
