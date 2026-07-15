import { Download, Square, Terminal } from "lucide-react"
import { useEffect, useRef } from "react"
import type { Job } from "@/shared/job-types"
import { getJobFileUrl } from "../api"

export function AgentLogs({
  job,
  is_stopping,
  on_cancel,
}: {
  job: Job
  is_stopping: boolean
  on_cancel: () => void
}) {
  const terminal_ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const terminal = terminal_ref.current
    if (terminal) terminal.scrollTop = terminal.scrollHeight
  }, [job.logs])

  const is_running = !job.is_complete

  return (
    <section className="workspace-card logs-card" aria-label="Agent logs">
      <header className="card-toolbar dark-toolbar">
        <div className="toolbar-title">
          <Terminal size={16} />
          <span title={job.file_name}>{job.file_name.replace(/\.pdf$/i, "")}</span>
        </div>
        <div className="toolbar-actions">
          {is_running && (
            <span className="run-indicator">
              <i /> {is_stopping ? "STOPPING…" : "RUNNING"}
            </span>
          )}
          {is_running && (
            <button className="stop-run-button" type="button" disabled={is_stopping} onClick={on_cancel}>
              <Square size={9} fill="currentColor" />
              {is_stopping ? "Stopping…" : "Stop run"}
            </button>
          )}
          <a
            className="toolbar-icon-link"
            href={getJobFileUrl(job.job_id, "log")}
            aria-label="Download complete agent log"
          >
            <Download size={15} />
          </a>
        </div>
      </header>
      <div className="terminal-window" ref={terminal_ref} aria-live="polite">
        {job.logs.length === 0 ? <span className="terminal-muted">Waiting for the agent…</span> : null}
        {job.logs.map((log) => (
          <span className={`terminal-chunk terminal-${log.stream}`} key={log.log_id}>
            {log.message}
          </span>
        ))}
        {is_running && <span className="terminal-cursor" />}
      </div>
    </section>
  )
}
