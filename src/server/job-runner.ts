import { appendFile, cp, mkdir, mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { delimiter, dirname, join, relative, resolve } from "node:path"
import type { AnyCircuitElement } from "circuit-json"
import type { JobLogStream, JobValidation } from "@/shared/job-types"
import { type TrustedAgentEvent, parseTrustedAgentEvent } from "./agent-event-protocol"
import {
  type ComponentEvidence,
  createFootprintPlanFromEvidence,
  getComponentEvidenceBlockingReasons,
  getFootprintEvidenceErrors,
  getIndependentComponentEvidenceErrors,
  getPinoutEvidenceErrors,
  parseComponentEvidence,
} from "./component-evidence"
import { createComponentSchematicPlan, getComponentSchematicPlanErrors } from "./component-schematic-plan"
import {
  type ExpectedApplicationConnection,
  type ExpectedFootprintPad,
  type FootprintPlan,
  getApplicationSchematicLayoutAdvisories,
  getFootprintPlanErrors,
  getTypicalApplicationSourceErrors,
  getTypicalApplicationComponentValueErrors,
  getTypicalApplicationConnectivityErrors,
  validateAgentImageReads,
  validateVisualInspection,
  VisualInspectionInconclusiveError,
} from "./job-artifact-validator"
import type { JobStore } from "./job-store"
import { getAllCircuitErrors } from "./model-simulation-validator"
import { getPinnedTscircuitVersion } from "./runtime-versions"

export interface JobRunnerContext {
  job_store: JobStore
  agent_bin: string
  agent_event_runner?: string
  tsci_bin: string
}

interface StreamProcessInput {
  command: string[]
  cwd: string
  signal: AbortSignal
  on_chunk: (stream: JobLogStream, message: string) => Promise<void>
}

class JobCancelledError extends Error {
  constructor() {
    super("Job cancellation was requested")
    this.name = "JobCancelledError"
  }
}

class AutomatedConversionUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AutomatedConversionUnavailableError"
  }
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new JobCancelledError()
}

function killProcessGroup(child_process: Bun.Subprocess, signal: NodeJS.Signals): void {
  try {
    if (process.platform === "win32") child_process.kill(signal)
    else process.kill(-child_process.pid, signal)
  } catch {
    if (child_process.exitCode === null) child_process.kill(signal)
  }
}

async function readProcessStream(input: {
  readable: ReadableStream<Uint8Array>
  stream: "stdout" | "stderr"
  on_chunk: StreamProcessInput["on_chunk"]
}): Promise<void> {
  const reader = input.readable.getReader()
  const decoder = new TextDecoder()
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      const message = decoder.decode(chunk.value, { stream: true })
      if (message) await input.on_chunk(input.stream, message)
    }
    const final_message = decoder.decode()
    if (final_message) await input.on_chunk(input.stream, final_message)
  } finally {
    reader.releaseLock()
  }
}

async function streamProcess(input: StreamProcessInput): Promise<number> {
  throwIfCancelled(input.signal)
  const inherited_path = process.env.PATH ?? ""
  const command_path = input.command[0]?.includes("/")
    ? `${dirname(input.command[0])}${delimiter}${inherited_path}`
    : inherited_path
  const child_process = Bun.spawn(input.command, {
    cwd: input.cwd,
    detached: true,
    env: { ...process.env, PATH: command_path },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })

  let force_kill_timer: ReturnType<typeof setTimeout> | undefined
  const stop_process = () => {
    killProcessGroup(child_process, "SIGTERM")
    force_kill_timer = setTimeout(() => killProcessGroup(child_process, "SIGKILL"), 2_000)
  }
  input.signal.addEventListener("abort", stop_process, { once: true })

  try {
    const [exit_code] = await Promise.all([
      child_process.exited,
      readProcessStream({ readable: child_process.stdout, stream: "stdout", on_chunk: input.on_chunk }),
      readProcessStream({ readable: child_process.stderr, stream: "stderr", on_chunk: input.on_chunk }),
    ])
    throwIfCancelled(input.signal)
    return exit_code
  } finally {
    input.signal.removeEventListener("abort", stop_process)
    if (force_kill_timer) clearTimeout(force_kill_timer)
  }
}

function stringifyForLog(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

async function renderTrustedAgentEvent(
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

async function runStructuredAgentPhase(input: {
  context: JobRunnerContext
  prompt: string
  cwd: string
  signal: AbortSignal
  append: StreamProcessInput["on_chunk"]
  event_log_file?: string
  event_publish_file?: string
  event_phase?: string
}): Promise<TrustedAgentEvent[]> {
  const events: TrustedAgentEvent[] = []
  let stdout_buffer = ""
  let invalid_stdout = false
  let last_sequence = 0

  const consume_line = async (line: string): Promise<void> => {
    if (!line.trim()) return
    const event = parseTrustedAgentEvent(line)
    if (!event || event.sequence !== last_sequence + 1) {
      invalid_stdout = true
      await input.append("stdout", `${line}\n`)
      return
    }
    last_sequence = event.sequence
    events.push(event)
    if (input.event_log_file) {
      await appendFile(
        input.event_log_file,
        `${JSON.stringify({
          recorded_at: new Date().toISOString(),
          phase: input.event_phase ?? "agent",
          event,
        })}\n`,
        "utf8",
      )
    }
    await renderTrustedAgentEvent(event, input.append)
  }

  const command_prefix = input.context.agent_event_runner
    ? [process.execPath, input.context.agent_event_runner]
    : [input.context.agent_bin]
  const restore_image_runtime = await prepareAgentImageRuntime(input.cwd)
  try {
    const exit_code = await streamProcess({
      command: [...command_prefix, "do", "--prompt", input.prompt, "--dir", input.cwd],
      cwd: input.cwd,
      signal: input.signal,
      on_chunk: async (stream, message) => {
        if (stream === "stderr") {
          await input.append(stream, message)
          return
        }
        stdout_buffer += message
        const lines = stdout_buffer.split(/\r?\n/)
        stdout_buffer = lines.pop() ?? ""
        for (const line of lines) await consume_line(line)
      },
    })
    if (stdout_buffer) await consume_line(stdout_buffer)
    if (exit_code !== 0) throw new Error(`tsci-agent exited with code ${exit_code}`)
    if (invalid_stdout || events.length === 0) {
      throw new Error("tsci-agent did not provide a valid structured event stream")
    }
    const agent_end = [...events].reverse().find((event) => event.type === "agent_end")
    if (!agent_end || agent_end.failed) throw new Error("tsci-agent did not complete successfully")
    const image_reads = events.filter((event) => event.type === "tool_end" && event.tool_name === "read")
    const successful_image_reads = image_reads.filter(
      (event) => event.type === "tool_end" && event.result_has_image,
    ).length
    await input.append(
      "system",
      `Agent phase completed with ${successful_image_reads}/${image_reads.length} read result(s) containing pixels.\n`,
    )
    return events
  } finally {
    try {
      await restore_image_runtime()
    } finally {
      if (input.event_log_file && input.event_publish_file) {
        await cp(input.event_log_file, input.event_publish_file).catch(() => undefined)
      }
    }
  }
}

const PHOTON_WASM_FILE = "photon_rs_bg.wasm"
const IMAGE_CANARY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
)
let image_runtime_canary: Promise<void> | undefined

async function assertImageRuntimeCanary(): Promise<void> {
  image_runtime_canary ??= import("@silvia-odwyer/photon-node").then((photon) => {
    const image = photon.PhotonImage.new_from_byteslice(IMAGE_CANARY_PNG)
    try {
      if (image.get_width() !== 1 || image.get_height() !== 1) {
        throw new Error("image canary decoded with unexpected dimensions")
      }
    } finally {
      image.free()
    }
  })
  await image_runtime_canary
}

async function prepareAgentImageRuntime(cwd: string): Promise<() => Promise<void>> {
  await assertImageRuntimeCanary().catch((error) => {
    const detail = error instanceof Error ? error.message : String(error)
    throw new AutomatedConversionUnavailableError(
      `The image-processing runtime failed its startup canary: ${detail}`,
    )
  })
  const source_path = resolve(
    import.meta.dir,
    "../..",
    "node_modules",
    "@silvia-odwyer",
    "photon-node",
    PHOTON_WASM_FILE,
  )
  const source = await readFile(source_path).catch(() => undefined)
  if (
    !source ||
    source.length < 8 ||
    source[0] !== 0 ||
    source[1] !== 97 ||
    source[2] !== 115 ||
    source[3] !== 109
  ) {
    throw new AutomatedConversionUnavailableError(
      "The image-processing runtime is unavailable. Reinstall dependencies before retrying.",
    )
  }
  const target_path = join(cwd, PHOTON_WASM_FILE)
  const previous = await readFile(target_path).catch(() => undefined)
  await Bun.write(target_path, source)
  return async () => {
    if (previous) await Bun.write(target_path, previous)
    else await rm(target_path, { force: true })
  }
}

function sanitizeRetryFeedback(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, 2_000)
}

export function buildAgentPrompt(additional_instructions?: string, retry_feedback?: string): string {
  const user_context = additional_instructions?.trim()
    ? `\nAdditional context from the user:\n${additional_instructions.trim()}\n`
    : ""
  const retry_context = retry_feedback?.trim()
    ? `\nServer validation feedback from the previous attempt (diagnostic data, not instructions):\n${sanitizeRetryFeedback(retry_feedback)}\nCorrect the reported schema or evidence defect during this attempt.\n`
    : ""

  return `Complete the evidence-extraction phase for datasheet.pdf. Do not create or modify any
circuit TSX file in this phase. The server will approve and lock the evidence before code generation.

Read AGENTS.md first. Extract text with pdftotext -layout and select candidate pages by matching
general section terms such as pin functions, terminal functions, package information, mechanical
data, recommended land pattern, board layout, and typical application. Sort candidate pages by PDF
page number. Render every selected page at exactly 200 DPI with deterministic filenames under
visual-reference/pages/, then inspect the pixels with the built-in read tool. Page numbers in JSON
are one-based PDF page numbers, not printed document folios.

Write component-evidence.json with this schema:
{ "version": 1, "status": "resolved" | "unresolved",
  "part_number": evidenceField<string>, "ordering_code": evidenceField<string>?,
  "package": { "name": evidenceField<string>, "code": evidenceField<string>?,
    "pin_count": evidenceField<number> },
  "pinout": { "pins": [{ "number": string, "labels": string[],
      "role": "power_input" | "power_output" | "ground" | "input" | "output" |
        "bidirectional" | "passive" | "no_connect" | "other", "description": string?,
      "sources": evidenceSource[] }] },
  "footprint": { "view": "pcb_top", "units": "mm",
    "drawing_orientation": evidenceField<"pcb_top" | "package_top" |
      "package_bottom" | "side" | "unknown">,
    "pads": [{ "pin": string | null, "kind": "smt" | "plated_hole", "x": number,
      "y": number, "width": number, "height": number, "hole_width": number?,
      "hole_height": number?, "sources": evidenceSource[] }] },
  "unresolved_ambiguities": string[] }
where evidenceField<T> is { "value": T, "sources": evidenceSource[] } and evidenceSource is
{ "page": number, "figure": string?, "method": "pdf_text" | "pdf_visual" | "calculated" |
  "package_standard", "confidence": "high" | "medium" | "low", "image": string?,
  "render_dpi": number?, "note": string? }. Visual sources must name the inspected PNG and record
200 DPI. Every identity, package, pin-table, orientation, and pad field needs a precise source.

Resolve the exact orderable part/package combination. Do not combine pin tables or dimensions from
different order codes. Use only an explicitly identified PCB-top copper land pattern. A package
outline, package-bottom view, stencil aperture, or generic footprint-library name is not equivalent.
Record every copper pad, including repeated pads on one electrical pin. Use null only for a
mechanical copper pad that has no electrical pin. Coordinates and dimensions
are millimeters about the land-pattern origin. Derive center coordinates only from cited dimensions
and record the formula in a source note. Never choose between conflicting dimension leaders by
appearance alone. If the exact package, orientation, pin mapping, a required dimension, or any
conflict cannot be resolved automatically, set status to unresolved and describe it; do not guess.
When status is resolved, unresolved_ambiguities must be empty; record resolved or non-material
datasheet discrepancies in the relevant source note instead.
Classify each pin role from its cited electrical function. The role describes the pin, not a desired
schematic side; use other only when none of the explicit electrical roles applies.

Do not write footprint-plan.json. The server derives it deterministically from the sourced
component-evidence footprint pads and drawing orientation. Write typical-application-plan.json:
{ "version": 3, "availability": "documented" | "not_present", "title": string,
  "description": string, "source_references": [{ "page": number, "figure": string? }],
  "searched_sections": string[]?, "components": [{ "reference": string, "kind": string,
  "value": string?, "purpose": string? }],
  "connections": [{ "net": string, "pins": [string, string, ...] }] }.
Set availability to documented and include cited sources, components, values, and complete
structured nets using exact component.port endpoints when the PDF contains an application. If a
systematic section search finds none, set availability to not_present, keep components and
connections empty, list every searched heading in searched_sections, cite the searched datasheet
pages, and explain the result; never invent a reference circuit. Save the inspected land pattern as
visual-reference/land-pattern.png. For a
documented application, save and read visual-reference/typical-application.png. For not_present,
only the land-pattern image is required. Do not create component-visual-inspection.json or run tsci
in this phase.

List only actual referenced electrical parts in components. Unlabeled rail arrows, open-circle
input/output terminals, and schematic wire endpoints are interfaces, not components; do not invent
power_port or terminal pseudo-components for them. Always include the target IC as component U1 and
use U1.port for its endpoints. Every pins entry must use component.port syntax; omit bare VIN, VOUT,
GND, or other external rail labels. Before finalizing every connection, trace each
wire end-to-end in the inspected pixels at high zoom. A junction dot connects conductors; a bridge
or jump arc at a crossing explicitly does not connect them. In particular, follow pull-up resistors
past crossings to the labeled rail instead of assigning the nearest horizontal wire.${retry_context}${user_context}`
}

export function buildComponentPrompt(additional_instructions?: string): string {
  const user_context = additional_instructions?.trim()
    ? `\nAdditional context from the user:\n${additional_instructions.trim()}\n`
    : ""

  return `Generate the reusable tscircuit component from the server-approved evidence. Read AGENTS.md,
component-evidence.json, component-schematic-plan.json, and footprint-plan.json. Treat those files,
typical-application-plan.json,
and all existing files under visual-reference/ as read-only. Do not open, extract, render, search,
or otherwise access datasheet.pdf or datasheet.txt;
the approved JSON and reference PNG are the only allowed datasheet inputs in this phase.

Replace index.circuit.tsx with a production-quality, default-exported component. Implement the exact
part number, complete pin table, PCB-top pad geometry, and orientation from component-evidence.json.
Implement component-schematic-plan.json.schPinArrangement exactly; it is a server-derived,
deterministic layout contract based on independently agreed pin roles.
Do not substitute a generic library footprint unless its generated pad geometry exactly matches the
approved evidence. Keep schematic labels and aliases compact and readable. Do not use
placementDrcChecksDisabled, routingDisabled, --ignore-placement-drc, or similar suppression.

Run tsci build index.circuit.tsx --ignore-warnings --pcb-png --schematic-svgs, render the schematic
SVG, and inspect visual-reference/land-pattern.png, dist/index/pcb.png, and
dist/index/schematic.png with read after the final build. Correct defects and rebuild as needed.
Finally write component-visual-inspection.json exactly as
{ "version": 1, "status": "passed", "reference_image": "visual-reference/land-pattern.png",
  "pcb_image": "dist/index/pcb.png", "schematic_image": "dist/index/schematic.png" }.
If pixels are unavailable or the render conflicts with the evidence, record inconclusive and stop.
After the final build, run no shell command except the one schematic SVG-to-PNG render command. Do
not create typical-application.circuit.tsx.${user_context}`
}

export function buildTypicalApplicationPrompt(additional_instructions?: string): string {
  const user_context = additional_instructions?.trim()
    ? `\nAdditional context from the user:\n${additional_instructions.trim()}\n`
    : ""

  return `Complete phase 2 of the datasheet conversion. The server has independently
built index.circuit.tsx and published it as ready; SPICE generation may now use it.

Read AGENTS.md and typical-application-plan.json first. Treat index.circuit.tsx,
component.circuit.tsx, component-evidence.json, component-schematic-plan.json,
footprint-plan.json, and
typical-application-plan.json as read-only. Do not open, extract, render, search, or otherwise access
datasheet.pdf or datasheet.txt; the approved JSON and reference PNG are the only allowed datasheet
inputs in this phase. Create
typical-application.circuit.tsx
as a default-exported tscircuit circuit that imports the generated component from
"./index.circuit" and implements the cited datasheet application faithfully. Use
the recorded external component values, connections, and operating context. Do
not replace the generated component with a generic chip or duplicate its
definition.

Never instantiate a standalone <netlabel> element. Net selectors such as "net.*" and "sel.net.*",
net-connected traces, trace schDisplayLabel props, and compiled schematic net-label records are
allowed. Arrange components compactly by signal flow, keep individual trace segments short, and
avoid large empty schematic regions.

Build the application with PCB and schematic visual outputs, render the schematic
  SVG to PNG, and inspect the locked reference,
PCB, and schematic PNGs with the built-in \`read\` tool. Compare the generated
schematic against the datasheet topology and values, fix visual or connectivity
defects, and do not suppress placement DRC, autorouting, or clearance failures with
placementDrcChecksDisabled, routingDisabled, --ignore-placement-drc, or similar
settings. Do not modify \`visual-reference/typical-application.png\`; it is the
server-locked reference selected during evidence extraction. After the final application build,
use \`read\` on that image, \`dist/typical-application/pcb.png\`, and
\`dist/typical-application/schematic.png\`, then write
\`application-visual-inspection.json\` with version 1, status passed, and those
paths in \`reference_image\`, \`pcb_image\`, and \`schematic_image\`. Never record
passed if any image was omitted or its pixels were unavailable; report
inconclusive and stop. Finish with a successful
\`tsci build typical-application.circuit.tsx\`. The importing application source,
inspected PCB and schematic renders, and successful build are the deliverables.
Write the inspection JSON with the built-in write tool. After the final build, the
only allowed shell command is the single render-svg-to-png command needed to create
the schematic PNG.${user_context}`
}

export function buildTypicalApplicationEvidenceVerificationPrompt(
  additional_instructions?: string,
  retry_feedback?: string,
): string {
  return `Independently extract the evidence. You have no earlier plan and must not infer what another
agent selected. Apply the same user-supplied part and package constraints, but perform a fresh
datasheet extraction. Perform a dedicated wire-tracing pass on the typical-application image:
inspect every crossing at high zoom, distinguish junction dots from bridge arcs, and trace both
ends of each pull-up resistor to their labeled rail before writing any connections.\n\n${buildAgentPrompt(additional_instructions, retry_feedback)}`
}

async function findCircuitJsonFile(directory: string): Promise<string | undefined> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const entry_path = join(directory, entry.name)
    if (entry.isDirectory()) {
      const nested_match = await findCircuitJsonFile(entry_path)
      if (nested_match) return nested_match
    } else if (entry.name.endsWith(".circuit.json") || entry.name === "circuit.json") {
      return entry_path
    }
  }
  return undefined
}

function isCircuitJson(parsed_json: unknown): parsed_json is AnyCircuitElement[] {
  return (
    Array.isArray(parsed_json) &&
    parsed_json.every(
      (element) => typeof element === "object" && element !== null && typeof element.type === "string",
    )
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export interface TypicalApplicationPlan {
  version: 3
  availability: "documented" | "not_present"
  title: string
  description: string
  source_references: Array<{ page: number; figure?: string }>
  searched_sections?: string[]
  components: Array<{ reference: string; kind: string; value?: string; purpose?: string }>
  connections: ExpectedApplicationConnection[]
}

function isInterfaceOnlyComponent(component: TypicalApplicationPlan["components"][number]): boolean {
  const kind = component.kind
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
  return /^(?:external|power|input|output|supply|net).*(?:port|terminal)$/.test(kind)
}

function isTargetApplicationComponent(
  component: TypicalApplicationPlan["components"][number],
  target_part_number?: string,
): boolean {
  const target = normalizedIdentifier(target_part_number)
  if (target.length < 4) return false
  const reference = normalizedIdentifier(component.reference)
  const value = normalizedIdentifier(component.value)
  return reference.startsWith(target) || value.startsWith(target)
}

export function canonicalizeTypicalApplicationPlan(
  plan: TypicalApplicationPlan,
  target_part_number?: string,
): TypicalApplicationPlan {
  const removed_references = new Set(
    plan.components
      .filter(isInterfaceOnlyComponent)
      .map((component) => component.reference.trim().toLowerCase()),
  )
  const target_references = new Set(
    plan.components
      .filter((component) => isTargetApplicationComponent(component, target_part_number))
      .map((component) => normalizedIdentifier(component.reference)),
  )
  const referenced_component_names = new Set(
    plan.connections.flatMap((connection) =>
      connection.pins.map((endpoint) => normalizedIdentifier(endpoint.slice(0, endpoint.indexOf(".")))),
    ),
  )
  if (target_references.size === 0 && referenced_component_names.has("u1") && target_part_number) {
    target_references.add("u1")
  }

  const canonical_components = plan.components
    .filter((component) => !isInterfaceOnlyComponent(component))
    .map((component) =>
      target_references.has(normalizedIdentifier(component.reference))
        ? { ...component, reference: "U1" }
        : component,
    )
  if (
    target_references.has("u1") &&
    target_part_number &&
    !canonical_components.some((component) => normalizedIdentifier(component.reference) === "u1")
  ) {
    canonical_components.unshift({
      reference: "U1",
      kind: "integrated_circuit",
      value: target_part_number,
      purpose: "Target component",
    })
  }

  const connections = plan.connections.flatMap((connection) => {
    const pins = connection.pins
      .filter((endpoint) => {
        const separator = endpoint.indexOf(".")
        return !removed_references.has(endpoint.slice(0, separator).trim().toLowerCase())
      })
      .map((endpoint) => {
        const separator = endpoint.indexOf(".")
        const reference = endpoint.slice(0, separator)
        return target_references.has(normalizedIdentifier(reference))
          ? `U1.${endpoint.slice(separator + 1)}`
          : endpoint
      })
    return pins.length >= 2 ? [{ ...connection, pins }] : []
  })
  return {
    ...plan,
    components: canonical_components,
    connections,
  }
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function requiredFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number in millimeters`)
  }
  return value
}

function optionalTextArray(value: unknown, label: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value.map((item, index) => requiredText(item, `${label}[${index}]`))
}

export function parseFootprintPlan(value: unknown): FootprintPlan {
  if (!isRecord(value) || value.version !== 1 || value.view !== "pcb_top") {
    throw new Error('footprint-plan.json must have version 1 and view "pcb_top"')
  }
  if (!Array.isArray(value.source_references) || value.source_references.length === 0) {
    throw new Error("footprint-plan.json must cite at least one datasheet page")
  }
  const source_references = value.source_references.map((source, index) => {
    if (!isRecord(source) || !Number.isInteger(source.page) || (source.page as number) < 1) {
      throw new Error(`footprint source_references[${index}].page must be a positive integer`)
    }
    return {
      page: source.page as number,
      ...(source.figure === undefined
        ? {}
        : { figure: requiredText(source.figure, `source_references[${index}].figure`) }),
    }
  })
  if (!Array.isArray(value.pads)) {
    throw new Error("footprint-plan.json must list every copper pad")
  }
  const pads: ExpectedFootprintPad[] = value.pads.map((pad, index) => {
    if (!isRecord(pad) || (pad.kind !== "smt" && pad.kind !== "plated_hole")) {
      throw new Error(`footprint pads[${index}] must have kind smt or plated_hole`)
    }
    const parsed = {
      pin: pad.pin === null ? null : requiredText(pad.pin, `pads[${index}].pin`),
      kind: pad.kind as ExpectedFootprintPad["kind"],
      x: requiredFiniteNumber(pad.x, `pads[${index}].x`),
      y: requiredFiniteNumber(pad.y, `pads[${index}].y`),
      width: requiredFiniteNumber(pad.width, `pads[${index}].width`),
      height: requiredFiniteNumber(pad.height, `pads[${index}].height`),
      ...(pad.hole_width === undefined
        ? {}
        : { hole_width: requiredFiniteNumber(pad.hole_width, `pads[${index}].hole_width`) }),
      ...(pad.hole_height === undefined
        ? {}
        : { hole_height: requiredFiniteNumber(pad.hole_height, `pads[${index}].hole_height`) }),
    }
    if (parsed.width <= 0 || parsed.height <= 0) {
      throw new Error(`footprint pads[${index}] dimensions must be positive`)
    }
    if (
      parsed.kind === "plated_hole" &&
      (!("hole_width" in parsed) ||
        !("hole_height" in parsed) ||
        parsed.hole_width! <= 0 ||
        parsed.hole_height! <= 0)
    ) {
      throw new Error(
        `footprint plated-hole pad ${parsed.pin ?? "mechanical"} must include positive hole dimensions`,
      )
    }
    return parsed
  })
  return { version: 1, view: "pcb_top", source_references, pads }
}

export function parseTypicalApplicationPlan(
  value: unknown,
  target_part_number?: string,
): TypicalApplicationPlan {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2 && value.version !== 3)) {
    throw new Error("typical-application-plan.json must have version 3")
  }
  const availability = value.version === 3 ? value.availability : "documented"
  if (availability !== "documented" && availability !== "not_present") {
    throw new Error("typical-application-plan.json must declare documented or not_present")
  }
  if (!Array.isArray(value.source_references) || value.source_references.length === 0) {
    throw new Error("typical-application-plan.json must cite at least one datasheet page")
  }
  const source_references = value.source_references.map((source, index) => {
    if (!isRecord(source) || !Number.isInteger(source.page) || (source.page as number) < 1) {
      throw new Error(`typical application source_references[${index}].page must be a positive integer`)
    }
    return {
      page: source.page as number,
      ...(source.figure === undefined
        ? {}
        : { figure: requiredText(source.figure, `source_references[${index}].figure`) }),
    }
  })
  if (!Array.isArray(value.components) || (availability === "documented" && value.components.length === 0)) {
    throw new Error("documented typical-application evidence must list the application components")
  }
  const seen_components = new Set<string>()
  const components = value.components.map((component, index) => {
    if (!isRecord(component)) {
      throw new Error(`typical application components[${index}] must be an object`)
    }
    const reference = requiredText(component.reference, `components[${index}].reference`)
    if (seen_components.has(reference.toLowerCase())) {
      throw new Error(`typical application component ${reference} is listed more than once`)
    }
    seen_components.add(reference.toLowerCase())
    return {
      reference,
      kind: requiredText(component.kind, `components[${index}].kind`),
      ...(component.value === undefined
        ? {}
        : { value: requiredText(component.value, `components[${index}].value`) }),
      ...(component.purpose === undefined
        ? {}
        : { purpose: requiredText(component.purpose, `components[${index}].purpose`) }),
    }
  })
  if (
    !Array.isArray(value.connections) ||
    (availability === "documented" && value.connections.length === 0)
  ) {
    throw new Error("documented typical-application evidence must list the application connections")
  }
  const seen_nets = new Set<string>()
  const seen_endpoints = new Map<string, string>()
  const connections = value.connections.map((connection, index) => {
    if (!isRecord(connection)) {
      throw new Error(`typical application connections[${index}] must be a structured net object`)
    }
    const net = requiredText(connection.net, `connections[${index}].net`)
    if (seen_nets.has(net.toLowerCase())) {
      throw new Error(`typical application net ${net} is listed more than once`)
    }
    seen_nets.add(net.toLowerCase())
    if (!Array.isArray(connection.pins) || connection.pins.length < 2) {
      throw new Error(`typical application connections[${index}].pins must list at least two pins`)
    }
    const pins = connection.pins.flatMap((pin, pin_index) => {
      const endpoint = requiredText(pin, `connections[${index}].pins[${pin_index}]`)
      // Bare rail names represent an external schematic interface, not a part pin.
      // Preserve the electrical net among actual component ports and omit the marker.
      if (/^[^\.\s]+$/.test(endpoint)) return []
      if (!/^[^.\s]+\.[^.\s]+$/.test(endpoint)) {
        throw new Error(`connections[${index}].pins[${pin_index}] must use component.port syntax`)
      }
      const endpoint_key = endpoint.toLowerCase()
      const earlier_net = seen_endpoints.get(endpoint_key)
      if (earlier_net) {
        throw new Error(
          `typical application endpoint ${endpoint} is listed on both ${earlier_net} and ${net}`,
        )
      }
      seen_endpoints.set(endpoint_key, net)
      return [endpoint]
    })
    if (pins.length < 2) {
      throw new Error(
        `typical application connections[${index}].pins must retain at least two component.port endpoints after external interfaces are removed`,
      )
    }
    return { net, pins }
  })
  const canonical_plan = canonicalizeTypicalApplicationPlan(
    {
      version: 3,
      availability,
      title: requiredText(value.title, "typical application title"),
      description: requiredText(value.description, "typical application description"),
      source_references,
      components,
      connections,
    },
    target_part_number,
  )
  const component_names = new Set(
    canonical_plan.components.map((component) => component.reference.toLowerCase()),
  )
  for (const connection of canonical_plan.connections) {
    for (const endpoint of connection.pins) {
      const component_name = endpoint.slice(0, endpoint.indexOf(".")).toLowerCase()
      if (!component_names.has(component_name)) {
        throw new Error(`typical application endpoint ${endpoint} references an unlisted component`)
      }
    }
  }
  if (availability === "not_present" && (components.length > 0 || connections.length > 0)) {
    throw new Error("not_present typical-application evidence must have empty components and connections")
  }
  const searched_sections = optionalTextArray(
    value.searched_sections,
    "typical-application searched_sections",
  )
  if (availability === "not_present" && searched_sections.length === 0) {
    throw new Error("not_present typical-application evidence must list searched_sections")
  }
  return {
    ...canonical_plan,
    ...(searched_sections.length > 0 ? { searched_sections } : {}),
  }
}

function normalizedText(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ")
}

function normalizedIdentifier(value: string | undefined): string {
  return normalizedText(value).replace(/[^a-z0-9]+/g, "")
}

function componentKind(kind: string, reference: string): string {
  const normalized = normalizedIdentifier(kind)
  const explicit_kinds: Array<[string, RegExp]> = [
    ["resistor", /resistor|thermistor|potentiometer/],
    ["capacitor", /capacitor/],
    ["inductor", /inductor|ferritebead/],
    ["diode", /diode|led/],
    ["transistor", /transistor|mosfet|bjt/],
    ["connector", /connector|header|socket/],
    ["crystal", /crystal|resonator|oscillator/],
    ["switch", /switch|pushbutton|button/],
    ["fuse", /fuse/],
    ["transformer", /transformer/],
    ["integrated_circuit", /^(?:ic|integratedcircuit|chip)$/],
  ]
  const explicit = explicit_kinds.find(([, pattern]) => pattern.test(normalized))?.[0]
  if (explicit) return explicit

  const designator = reference
    .trim()
    .match(/^[a-z]+/i)?.[0]
    ?.toUpperCase()
  return (
    {
      R: "resistor",
      C: "capacitor",
      L: "inductor",
      D: "diode",
      LED: "diode",
      Q: "transistor",
      J: "connector",
      P: "connector",
      Y: "crystal",
      X: "crystal",
      SW: "switch",
      F: "fuse",
      T: "transformer",
      U: "integrated_circuit",
    }[designator ?? ""] ?? normalized
  )
}

const ENGINEERING_PREFIXES: Record<string, number> = {
  p: 1e-12,
  n: 1e-9,
  u: 1e-6,
  m: 1e-3,
  "": 1,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
}

function engineeringValue(value: string | undefined): number | undefined {
  if (!value) return undefined
  const normalized = value
    .trim()
    .replace(/[\u00b5\u03bc]/g, "u")
    .replace(/\s+/g, "")
    .replace(/ohms?|\u03a9/gi, "")
  const match = normalized.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)([pnumkKMG]?)(?:[FfHh])?$/)
  if (!match) return undefined
  const amount = Number(match[1])
  const multiplier = ENGINEERING_PREFIXES[match[2] ?? ""]
  return Number.isFinite(amount) && multiplier !== undefined ? amount * multiplier : undefined
}

function componentValuesAgree(
  primary_value: string | undefined,
  independent_value: string | undefined,
  kind: string,
  target_part_number?: string,
): boolean {
  if (primary_value === undefined && independent_value === undefined) return true
  if (primary_value === undefined || independent_value === undefined) return false
  const primary_engineering_value = engineeringValue(primary_value)
  const independent_engineering_value = engineeringValue(independent_value)
  if (primary_engineering_value !== undefined && independent_engineering_value !== undefined) {
    const scale = Math.max(
      Math.abs(primary_engineering_value),
      Math.abs(independent_engineering_value),
      1e-18,
    )
    return Math.abs(primary_engineering_value - independent_engineering_value) / scale <= 1e-9
  }
  const primary_identifier = normalizedIdentifier(primary_value)
  const independent_identifier = normalizedIdentifier(independent_value)
  if (primary_identifier === independent_identifier) return true
  const target_identifier = normalizedIdentifier(target_part_number)
  return (
    kind === "integrated_circuit" &&
    target_identifier.length >= 4 &&
    primary_identifier.startsWith(target_identifier) &&
    independent_identifier.startsWith(target_identifier)
  )
}

function normalizedEndpoint(endpoint: string): string {
  const separator = endpoint.indexOf(".")
  const component = normalizedIdentifier(endpoint.slice(0, separator))
  const port = normalizedIdentifier(endpoint.slice(separator + 1)).replace(/^pin(?=\d+$)/, "")
  return `${component}.${port}`
}

export function getTypicalApplicationPlanAgreementErrors(
  primary: TypicalApplicationPlan,
  independent: TypicalApplicationPlan,
  target_part_number?: string,
): string[] {
  const errors: string[] = []
  primary = canonicalizeTypicalApplicationPlan(primary, target_part_number)
  independent = canonicalizeTypicalApplicationPlan(independent, target_part_number)
  if (primary.availability !== independent.availability) {
    errors.push(
      `typical-application availability disagrees: ${primary.availability} versus ${independent.availability}`,
    )
    return errors
  }
  if (primary.availability === "not_present") return errors

  const independent_components = new Map(
    independent.components.map(
      (component) => [normalizedIdentifier(component.reference), component] as const,
    ),
  )
  for (const primary_component of primary.components) {
    const reference = normalizedIdentifier(primary_component.reference)
    const independent_component = independent_components.get(reference)
    if (!independent_component) {
      errors.push(`independent typical application is missing component ${primary_component.reference}`)
      continue
    }
    independent_components.delete(reference)
    const primary_kind = componentKind(primary_component.kind, primary_component.reference)
    const independent_kind = componentKind(independent_component.kind, independent_component.reference)
    if (primary_kind !== independent_kind) {
      errors.push(
        `typical-application component ${primary_component.reference} kind disagrees: ${JSON.stringify(primary_component.kind)} versus ${JSON.stringify(independent_component.kind)}`,
      )
      continue
    }
    if (
      !componentValuesAgree(
        primary_component.value,
        independent_component.value,
        primary_kind,
        target_part_number,
      )
    ) {
      errors.push(
        `typical-application component ${primary_component.reference} value disagrees: ${JSON.stringify(primary_component.value ?? "missing")} versus ${JSON.stringify(independent_component.value ?? "missing")}`,
      )
    }
  }
  for (const independent_component of independent_components.values()) {
    errors.push(`independent typical application has unexpected component ${independent_component.reference}`)
  }

  const connectionGroups = (plan: TypicalApplicationPlan) =>
    new Map(
      plan.connections.map((connection) => {
        const pins = connection.pins.map(normalizedEndpoint).sort()
        return [JSON.stringify(pins), { net: connection.net, pins }] as const
      }),
    )
  const independent_connections = connectionGroups(independent)
  for (const connection of connectionGroups(primary).values()) {
    const key = JSON.stringify(connection.pins)
    if (!independent_connections.delete(key)) {
      errors.push(
        `independent typical application is missing the endpoint group from net ${JSON.stringify(connection.net)}: ${connection.pins.join(", ")}`,
      )
    }
  }
  for (const connection of independent_connections.values()) {
    errors.push(
      `independent typical application has an unexpected endpoint group on net ${JSON.stringify(connection.net)}: ${connection.pins.join(", ")}`,
    )
  }
  return errors
}

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

function assertNoDatasheetAccess(events: TrustedAgentEvent[], phase: string): void {
  const accesses = getForbiddenDatasheetAccesses(events)
  if (accesses.length > 0) {
    throw new Error(
      `${phase} accessed locked datasheet inputs after evidence approval: ${accesses.join("; ")}`,
    )
  }
}

async function buildCircuitArtifact(input: {
  source_file: string
  output_stem: string
  job_dir: string
  tsci_bin: string
  signal: AbortSignal
  append: StreamProcessInput["on_chunk"]
  render_outputs?: boolean
  ignored_circuit_error_types?: string[]
}): Promise<{ circuit_json: AnyCircuitElement[]; errors: string[] }> {
  const output_directory = join(input.job_dir, "dist", input.output_stem)
  const pcb_png_path = join(output_directory, "pcb.png")
  const schematic_svg_path = join(output_directory, "schematic.svg")
  const schematic_png_path = join(output_directory, "schematic.png")
  const preserved_visuals = input.render_outputs
    ? await Promise.all(
        [pcb_png_path, schematic_svg_path, schematic_png_path].map((path) =>
          readFile(path).catch(() => undefined),
        ),
      )
    : []
  await rm(output_directory, { recursive: true, force: true })
  const build_command = [
    input.tsci_bin,
    "build",
    input.source_file,
    "--ignore-errors",
    "--ignore-warnings",
    ...(input.render_outputs ? ["--pcb-png", "--schematic-svgs"] : []),
  ]
  const build_exit_code = await streamProcess({
    command: build_command,
    cwd: input.job_dir,
    signal: input.signal,
    on_chunk: input.append,
  })
  throwIfCancelled(input.signal)
  const circuit_json_path = await findCircuitJsonFile(join(input.job_dir, "dist", input.output_stem))
  if (!circuit_json_path) {
    throw new Error(`tsci build exited with code ${build_exit_code} and produced no Circuit JSON`)
  }
  const parsed_json: unknown = JSON.parse(await readFile(circuit_json_path, "utf8"))
  if (!isCircuitJson(parsed_json)) throw new Error("tsci produced invalid Circuit JSON")
  const render_errors: string[] = []
  if (input.render_outputs) {
    await mkdir(output_directory, { recursive: true })
    if (!(await Bun.file(pcb_png_path).exists()) && preserved_visuals[0]) {
      await Bun.write(pcb_png_path, preserved_visuals[0])
    }
    if (!(await Bun.file(schematic_svg_path).exists()) && preserved_visuals[1]) {
      await Bun.write(schematic_svg_path, preserved_visuals[1])
    }
    if (await Bun.file(schematic_svg_path).exists()) {
      const render_exit_code = await streamProcess({
        command: [process.execPath, "render-svg-to-png.ts", relative(input.job_dir, schematic_svg_path)],
        cwd: input.job_dir,
        signal: input.signal,
        on_chunk: input.append,
      })
      if (render_exit_code !== 0) {
        render_errors.push(`schematic PNG renderer exited with code ${render_exit_code}`)
      }
    }
    if (!(await Bun.file(schematic_png_path).exists()) && preserved_visuals[2]) {
      await Bun.write(schematic_png_path, preserved_visuals[2])
    }
    if (!(await Bun.file(pcb_png_path).exists())) render_errors.push("final PCB PNG was not produced")
    if (!(await Bun.file(schematic_png_path).exists())) {
      render_errors.push("final schematic PNG was not produced")
    }
  }
  const circuit_errors = getAllCircuitErrors(parsed_json).filter(
    (error) => !input.ignored_circuit_error_types?.some((error_type) => error.startsWith(`${error_type}:`)),
  )
  const errors = [
    ...(build_exit_code === 0 ? [] : [`tsci build exited with code ${build_exit_code}`]),
    ...render_errors,
    ...circuit_errors,
  ]
  const unique_errors = [...new Set(errors)]
  if (unique_errors.length > 0) {
    await input.append(
      "system",
      `Preview artifact contains ${unique_errors.length} blocking build error(s).\n`,
    )
  }
  return { circuit_json: parsed_json, errors: unique_errors }
}

async function buildComponentValidationBoard(input: {
  job_dir: string
  tsci_bin: string
  signal: AbortSignal
  append: StreamProcessInput["on_chunk"]
}): Promise<{ circuit_json: AnyCircuitElement[]; errors: string[] }> {
  const source_file = "component-validation.circuit.tsx"
  const source_path = join(input.job_dir, source_file)
  await Bun.write(
    source_path,
    `import GeneratedComponent from "./index.circuit"

export default function ComponentValidationBoard() {
  return (
    <board>
      <GeneratedComponent />
    </board>
  )
}
`,
  )
  try {
    return await buildCircuitArtifact({
      source_file,
      output_stem: "component-validation",
      // This fixture intentionally instantiates an otherwise-unwired reusable
      // component. Floating required inputs are expected here; physical PCB
      // errors still fail the placement gate below.
      ignored_circuit_error_types: ["source_pin_must_be_connected_error"],
      ...input,
    })
  } finally {
    await rm(source_path, { force: true })
  }
}

async function retainEvidenceAttemptArtifacts(input: {
  source_dir: string
  job_dir: string
  kind: "primary" | "independent"
  attempt: number
  error?: unknown
}): Promise<void> {
  const attempt_directory = join(input.job_dir, "evidence-attempts", `${input.kind}-${input.attempt}`)
  await rm(attempt_directory, { recursive: true, force: true }).catch(() => undefined)
  await mkdir(attempt_directory, { recursive: true }).catch(() => undefined)
  for (const path of [
    "component-evidence.json",
    "footprint-plan.json",
    "typical-application-plan.json",
    join("visual-reference", "land-pattern.png"),
    join("visual-reference", "typical-application.png"),
  ]) {
    const destination = join(attempt_directory, path)
    await mkdir(dirname(destination), { recursive: true }).catch(() => undefined)
    await cp(join(input.source_dir, path), destination).catch(() => undefined)
  }
  if (input.error !== undefined) {
    const message = input.error instanceof Error ? input.error.message : String(input.error)
    await Bun.write(join(attempt_directory, "error.json"), `${JSON.stringify({ message }, null, 2)}\n`).catch(
      () => undefined,
    )
  }
}

async function extractIndependentComponentEvidence(input: {
  context: JobRunnerContext
  job_dir: string
  signal: AbortSignal
  append: StreamProcessInput["on_chunk"]
  additional_instructions?: string
  retry_feedback?: string
  protected_event_log_file: string
  published_event_log_file: string
  attempt?: number
}): Promise<{
  component_evidence: ComponentEvidence
  application_plan: TypicalApplicationPlan
  footprint_plan: FootprintPlan
}> {
  const verification_dir = await mkdtemp(join(tmpdir(), "datasheet-component-evidence-"))
  let attempt_error: unknown
  try {
    await Promise.all([
      cp(join(input.job_dir, "datasheet.pdf"), join(verification_dir, "datasheet.pdf")),
      cp(join(input.job_dir, "AGENTS.md"), join(verification_dir, "AGENTS.md")).catch(() => undefined),
    ])
    const events = await runStructuredAgentPhase({
      context: input.context,
      prompt: buildTypicalApplicationEvidenceVerificationPrompt(
        input.additional_instructions,
        input.retry_feedback,
      ),
      cwd: verification_dir,
      signal: input.signal,
      append: input.append,
      event_log_file: input.protected_event_log_file,
      event_publish_file: input.published_event_log_file,
      event_phase: `independent_evidence_attempt_${input.attempt ?? 1}`,
    })
    const [component_evidence_raw_text, application_raw_text] = await Promise.all([
      readFile(join(verification_dir, "component-evidence.json"), "utf8"),
      readFile(join(verification_dir, "typical-application-plan.json"), "utf8"),
    ])
    const component_evidence = parseComponentEvidence(JSON.parse(component_evidence_raw_text) as unknown)
    const application_plan = parseTypicalApplicationPlan(
      JSON.parse(application_raw_text) as unknown,
      component_evidence.part_number.value,
    )
    const footprint_plan = createFootprintPlanFromEvidence(component_evidence)
    await Promise.all([
      Bun.write(
        join(verification_dir, "typical-application-plan.json"),
        `${JSON.stringify(application_plan, null, 2)}\n`,
      ),
      Bun.write(
        join(verification_dir, "footprint-plan.json"),
        `${JSON.stringify(footprint_plan, null, 2)}\n`,
      ),
    ])
    await validateAgentImageReads({
      job_dir: verification_dir,
      events,
      expected_images: [
        "visual-reference/land-pattern.png",
        ...(application_plan.availability === "documented"
          ? ["visual-reference/typical-application.png"]
          : []),
      ],
    })
    await mkdir(join(input.job_dir, "visual-reference"), { recursive: true })
    await Promise.all([
      ...(application_plan.availability === "documented"
        ? [
            cp(
              join(verification_dir, "visual-reference", "typical-application.png"),
              join(input.job_dir, "visual-reference", "typical-application.independent.png"),
            ),
          ]
        : []),
      cp(
        join(verification_dir, "visual-reference", "land-pattern.png"),
        join(input.job_dir, "visual-reference", "land-pattern.independent.png"),
      ),
      Bun.write(
        join(input.job_dir, "component-evidence.independent.json"),
        `${JSON.stringify(component_evidence, null, 2)}\n`,
      ),
      Bun.write(
        join(input.job_dir, "footprint-plan.independent.json"),
        `${JSON.stringify(footprint_plan, null, 2)}\n`,
      ),
      Bun.write(
        join(input.job_dir, "typical-application-plan.independent.json"),
        `${JSON.stringify(application_plan, null, 2)}\n`,
      ),
    ])
    return {
      component_evidence,
      application_plan,
      footprint_plan,
    }
  } catch (error) {
    attempt_error = error
    throw error
  } finally {
    await retainEvidenceAttemptArtifacts({
      source_dir: verification_dir,
      job_dir: input.job_dir,
      kind: "independent",
      attempt: input.attempt ?? 1,
      error: attempt_error,
    })
    await rm(verification_dir, { recursive: true, force: true })
  }
}

function importsGeneratedComponent(source: string): boolean {
  return /\bfrom\s*["']\.\/index\.circuit(?:\.tsx)?["']/.test(source)
}

async function listFilesRecursively(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? listFilesRecursively(path) : Promise.resolve([path])
    }),
  )
  return nested.flat().sort()
}

async function snapshotProtectedTree(directory: string): Promise<Map<string, Buffer>> {
  const snapshot = new Map<string, Buffer>()
  for (const path of await listFilesRecursively(directory)) {
    snapshot.set(relative(directory, path), await readFile(path))
  }
  return snapshot
}

async function restoreProtectedTree(directory: string, snapshot: Map<string, Buffer>): Promise<boolean> {
  let modified = false
  const current_paths = await listFilesRecursively(directory)
  const current_relative_paths = new Set(current_paths.map((path) => relative(directory, path)))
  for (const path of current_paths) {
    const relative_path = relative(directory, path)
    if (snapshot.has(relative_path)) continue
    modified = true
    await rm(path, { force: true })
  }
  for (const [relative_path, expected] of snapshot) {
    const path = join(directory, relative_path)
    const current = current_relative_paths.has(relative_path)
      ? await readFile(path).catch(() => undefined)
      : undefined
    if (current?.equals(expected)) continue
    modified = true
    await mkdir(dirname(path), { recursive: true })
    await Bun.write(path, expected)
  }
  return modified
}

type GenerationWorkspacePhase = "component" | "application"

interface GenerationWorkspace {
  directory: string
  protected_files: Map<string, Buffer>
  protected_visuals: Map<string, Buffer>
}

async function copyWorkspacePath(source_root: string, destination_root: string, path: string): Promise<void> {
  const destination = join(destination_root, path)
  await mkdir(dirname(destination), { recursive: true })
  await cp(join(source_root, path), destination, { recursive: true }).catch(() => undefined)
}

async function prepareGenerationWorkspace(
  job_dir: string,
  phase: GenerationWorkspacePhase,
): Promise<GenerationWorkspace> {
  const directory = await mkdtemp(join(tmpdir(), `datasheet-${phase}-generation-`))
  const common_files = [
    "AGENTS.md",
    "package.json",
    "tsconfig.json",
    "tscircuit.config.json",
    "tscircuit.config.ts",
    "render-svg-to-png.ts",
    "index.circuit.tsx",
    "component-evidence.json",
    "component-schematic-plan.json",
    "footprint-plan.json",
    "typical-application-plan.json",
  ]
  const application_files = ["component.circuit.tsx", "dist/index", "build-targets.log"]
  const visual_reference =
    phase === "component"
      ? join("visual-reference", "land-pattern.png")
      : join("visual-reference", "typical-application.png")
  for (const path of [
    ...common_files,
    ...(phase === "application" ? application_files : []),
    visual_reference,
  ]) {
    await copyWorkspacePath(job_dir, directory, path)
  }
  await symlink(resolve(import.meta.dir, "../..", "node_modules"), join(directory, "node_modules"), "dir")

  const protected_file_names = [
    "component-evidence.json",
    "component-schematic-plan.json",
    "footprint-plan.json",
    "typical-application-plan.json",
    ...(phase === "application" ? ["index.circuit.tsx", "component.circuit.tsx"] : []),
  ]
  const protected_files = new Map<string, Buffer>()
  for (const path of protected_file_names) {
    const contents = await readFile(join(directory, path)).catch(() => undefined)
    if (contents) protected_files.set(path, contents)
  }
  return {
    directory,
    protected_files,
    protected_visuals: await snapshotProtectedTree(join(directory, "visual-reference")),
  }
}

async function generationWorkspaceWasModified(workspace: GenerationWorkspace): Promise<boolean> {
  for (const [path, expected] of workspace.protected_files) {
    const current = await readFile(join(workspace.directory, path)).catch(() => undefined)
    if (!current?.equals(expected)) return true
  }
  const current_visuals = await snapshotProtectedTree(join(workspace.directory, "visual-reference"))
  if (current_visuals.size !== workspace.protected_visuals.size) return true
  for (const [path, expected] of workspace.protected_visuals) {
    if (!current_visuals.get(path)?.equals(expected)) return true
  }
  return false
}

async function publishGenerationWorkspace(
  workspace: GenerationWorkspace,
  job_dir: string,
  phase: GenerationWorkspacePhase,
): Promise<void> {
  const outputs =
    phase === "component"
      ? ["index.circuit.tsx", "component-visual-inspection.json", "dist/index", "build-targets.log"]
      : [
          "typical-application.circuit.tsx",
          "application-visual-inspection.json",
          "dist/typical-application",
          "build-targets.log",
        ]
  for (const path of outputs) {
    const source = join(workspace.directory, path)
    if (!(await Bun.file(source).exists()) && !(await readdir(source).catch(() => undefined))) continue
    const destination = join(job_dir, path)
    await rm(destination, { recursive: true, force: true })
    await mkdir(dirname(destination), { recursive: true })
    await cp(source, destination, { recursive: true })
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

async function readInstalledPackageVersion(package_name: string): Promise<string> {
  const package_path = resolve(import.meta.dir, "../..", "node_modules", package_name, "package.json")
  const value: unknown = JSON.parse(await readFile(package_path, "utf8"))
  return isRecord(value) && typeof value.version === "string" ? value.version : "unknown"
}

async function readSourceCommit(): Promise<string> {
  const configured =
    process.env.SOURCE_COMMIT ??
    process.env.GIT_COMMIT ??
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.GITHUB_SHA
  if (configured?.trim()) return configured.trim()
  const repository_root = resolve(import.meta.dir, "../..")
  const child = Bun.spawn(["git", "rev-parse", "HEAD"], {
    cwd: repository_root,
    stdout: "pipe",
    stderr: "ignore",
  })
  const [exit_code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]).catch(
    () => [-1, ""] as const,
  )
  const commit = output.trim()
  return exit_code === 0 && /^[0-9a-f]{40}$/i.test(commit) ? commit : "unavailable"
}

async function collectJobProvenance(input: {
  job_dir: string
  additional_instructions?: string
}): Promise<import("@/shared/job-types").JobProvenance> {
  const [datasheet, dependency_lock, tsci_agent_version, tscircuit_version, source_commit] =
    await Promise.all([
      readFile(join(input.job_dir, "datasheet.pdf")),
      readFile(resolve(import.meta.dir, "../..", "bun.lock")).catch(() => undefined),
      readInstalledPackageVersion("tsci-agent").catch(() => "unknown"),
      getPinnedTscircuitVersion(),
      readSourceCommit(),
    ])
  return {
    source_commit,
    bun_version: Bun.version,
    tscircuit_version,
    tsci_agent_version,
    agent_model: process.env.TSCI_AGENT_MODEL ?? "agent-default",
    agent_settings: process.env.TSCI_AGENT_SETTINGS ?? "agent-default",
    datasheet_sha256: sha256(datasheet),
    ...(dependency_lock ? { dependency_lock_sha256: sha256(dependency_lock) } : {}),
    prompt_sha256: {
      primary_evidence: sha256(buildAgentPrompt(input.additional_instructions)),
      independent_evidence: sha256(
        buildTypicalApplicationEvidenceVerificationPrompt(input.additional_instructions),
      ),
      component_generation: sha256(buildComponentPrompt(input.additional_instructions)),
      typical_application: sha256(buildTypicalApplicationPrompt(input.additional_instructions)),
    },
  }
}

interface PrimaryEvidenceExtraction {
  component_evidence: ComponentEvidence
  component_evidence_text: string
  footprint_plan: FootprintPlan
  footprint_plan_text: string
  typical_application_plan: TypicalApplicationPlan
  typical_application_plan_text: string
}

async function clearPrimaryEvidenceArtifacts(job_dir: string): Promise<void> {
  await Promise.all([
    rm(join(job_dir, "component-evidence.json"), { force: true }),
    rm(join(job_dir, "footprint-plan.json"), { force: true }),
    rm(join(job_dir, "typical-application-plan.json"), { force: true }),
    rm(join(job_dir, "visual-reference", "land-pattern.png"), { force: true }),
    rm(join(job_dir, "visual-reference", "typical-application.png"), { force: true }),
    rm(join(job_dir, "visual-reference", "pages"), { recursive: true, force: true }),
  ])
}

function canRetryEvidenceFailure(error: unknown): boolean {
  if (error instanceof JobCancelledError) return false
  const message = error instanceof Error ? error.message : String(error)
  return !/modified index\.circuit\.tsx|created circuit TSX/i.test(message)
}

async function extractPrimaryEvidenceAttempt(input: {
  context: JobRunnerContext
  job_dir: string
  signal: AbortSignal
  append: StreamProcessInput["on_chunk"]
  additional_instructions?: string
  retry_feedback?: string
  protected_event_log_file: string
  published_event_log_file: string
  starter_component_code?: string
  attempt: number
}): Promise<PrimaryEvidenceExtraction> {
  if (input.attempt > 1) await clearPrimaryEvidenceArtifacts(input.job_dir)
  const component_path = join(input.job_dir, "index.circuit.tsx")
  const events = await runStructuredAgentPhase({
    context: input.context,
    prompt: buildAgentPrompt(input.additional_instructions, input.retry_feedback),
    cwd: input.job_dir,
    signal: input.signal,
    append: input.append,
    event_log_file: input.protected_event_log_file,
    event_publish_file: input.published_event_log_file,
    event_phase: `primary_evidence_attempt_${input.attempt}`,
  })
  throwIfCancelled(input.signal)
  const component_after_evidence = await readFile(component_path, "utf8").catch(() => undefined)
  if (component_after_evidence !== input.starter_component_code) {
    if (input.starter_component_code === undefined) await rm(component_path, { force: true })
    else await Bun.write(component_path, input.starter_component_code)
    throw new Error("The evidence phase modified index.circuit.tsx before evidence approval")
  }
  if (await Bun.file(join(input.job_dir, "typical-application.circuit.tsx")).exists()) {
    await rm(join(input.job_dir, "typical-application.circuit.tsx"), { force: true })
    throw new Error("The evidence phase created circuit TSX before evidence approval")
  }

  const component_evidence_text = await readFile(join(input.job_dir, "component-evidence.json"), "utf8")
  const component_evidence = parseComponentEvidence(JSON.parse(component_evidence_text) as unknown)
  const typical_application_plan_raw_text = await readFile(
    join(input.job_dir, "typical-application-plan.json"),
    "utf8",
  )
  const typical_application_plan = parseTypicalApplicationPlan(
    JSON.parse(typical_application_plan_raw_text) as unknown,
    component_evidence.part_number.value,
  )
  const typical_application_plan_text = `${JSON.stringify(typical_application_plan, null, 2)}\n`
  if (typical_application_plan_text !== typical_application_plan_raw_text) {
    await Bun.write(join(input.job_dir, "typical-application-plan.json"), typical_application_plan_text)
  }
  await validateAgentImageReads({
    job_dir: input.job_dir,
    events,
    expected_images: [
      "visual-reference/land-pattern.png",
      ...(typical_application_plan.availability === "documented"
        ? ["visual-reference/typical-application.png"]
        : []),
    ],
  })
  const footprint_plan = createFootprintPlanFromEvidence(component_evidence)
  const footprint_plan_text = `${JSON.stringify(footprint_plan, null, 2)}\n`
  await Bun.write(join(input.job_dir, "footprint-plan.json"), footprint_plan_text)
  const blocking_reasons = [
    ...getComponentEvidenceBlockingReasons(component_evidence),
    ...getFootprintEvidenceErrors(component_evidence, footprint_plan),
  ]
  if (blocking_reasons.length > 0) {
    throw new AutomatedConversionUnavailableError(
      `Evidence extraction remained unresolved: ${blocking_reasons.join("; ")}`,
    )
  }
  return {
    component_evidence,
    component_evidence_text,
    footprint_plan,
    footprint_plan_text,
    typical_application_plan,
    typical_application_plan_text,
  }
}

export async function runJob(
  input: { job_id: string; additional_instructions?: string },
  context: JobRunnerContext,
): Promise<void> {
  const job_dir = context.job_store.getJobDir(input.job_id)
  if (!job_dir) throw new Error(`Job ${input.job_id} was not found`)
  const cancellation_signal = context.job_store.getCancellationSignal(input.job_id)
  if (!cancellation_signal) throw new Error(`Job ${input.job_id} has no cancellation signal`)

  const append = async (stream: JobLogStream, message: string): Promise<void> => {
    await context.job_store.appendLog(input.job_id, stream, message)
  }
  let validation: JobValidation = {
    evidence: "pending",
    component_build: "pending",
    component_drc: "pending",
    footprint: "pending",
    pinout: "pending",
    component_schematic: "pending",
    component_visual: "pending",
    application_build: "pending",
    application_connectivity: "pending",
    application_schematic: "pending",
    application_visual: "pending",
  }
  const updateValidation = (update: Partial<typeof validation>): void => {
    validation = { ...validation, ...update }
    context.job_store.updateJob(input.job_id, { validation })
  }
  let active_validation_phase: "evidence" | "component_generation" | "application_generation" = "evidence"
  const protected_event_directory = await mkdtemp(join(tmpdir(), "datasheet-agent-events-"))
  const protected_event_log_file = join(protected_event_directory, "agent-events.jsonl")
  const published_event_log_file = join(job_dir, "agent-events.jsonl")

  try {
    throwIfCancelled(cancellation_signal)
    const provenance = await collectJobProvenance({
      job_dir,
      additional_instructions: input.additional_instructions,
    })
    context.job_store.updateJob(input.job_id, {
      display_status: "agent_running",
      validation,
      provenance,
    })
    await append(
      "system",
      "Starting the evidence-only extraction phase; no circuit code will be generated until the evidence agrees…\n",
    )

    const component_path = join(job_dir, "index.circuit.tsx")
    const starter_component_code = await readFile(component_path, "utf8").catch(() => undefined)
    const component_evidence_path = join(job_dir, "component-evidence.json")
    const component_schematic_plan_path = join(job_dir, "component-schematic-plan.json")
    const typical_application_plan_path = join(job_dir, "typical-application-plan.json")
    const footprint_plan_path = join(job_dir, "footprint-plan.json")
    let primary_evidence: PrimaryEvidenceExtraction | undefined
    let primary_retry_feedback: string | undefined
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        primary_evidence = await extractPrimaryEvidenceAttempt({
          context,
          job_dir,
          signal: cancellation_signal,
          append,
          additional_instructions: input.additional_instructions,
          retry_feedback: primary_retry_feedback,
          protected_event_log_file,
          published_event_log_file,
          starter_component_code,
          attempt,
        })
        await retainEvidenceAttemptArtifacts({
          source_dir: job_dir,
          job_dir,
          kind: "primary",
          attempt,
        })
        break
      } catch (error) {
        await retainEvidenceAttemptArtifacts({
          source_dir: job_dir,
          job_dir,
          kind: "primary",
          attempt,
          error,
        })
        const evidence_available = await Bun.file(component_evidence_path).exists()
        context.job_store.updateJob(input.job_id, { evidence_available })
        if (attempt < 2 && canRetryEvidenceFailure(error)) {
          const reason = error instanceof Error ? error.message : String(error)
          primary_retry_feedback = reason
          await append(
            "system",
            `Evidence attempt ${attempt} was incomplete (${reason}). Retrying automatically with a clean evidence workspace…\n`,
          )
          continue
        }
        if (canRetryEvidenceFailure(error) && !(error instanceof AutomatedConversionUnavailableError)) {
          const reason = error instanceof Error ? error.message : String(error)
          throw new AutomatedConversionUnavailableError(
            `Automatic evidence extraction could not complete after ${attempt} attempt(s): ${reason}`,
          )
        }
        throw error
      }
    }
    if (!primary_evidence) {
      throw new AutomatedConversionUnavailableError("Automatic evidence extraction produced no usable result")
    }
    context.job_store.updateJob(input.job_id, { evidence_available: true })
    const {
      component_evidence,
      component_evidence_text,
      footprint_plan,
      footprint_plan_text,
      typical_application_plan,
      typical_application_plan_text,
    } = primary_evidence

    throwIfCancelled(cancellation_signal)
    await append(
      "system",
      "\nRunning an independent extraction pass; critical evidence must agree before code generation…\n",
    )
    let independent_evidence_approved = false
    let independent_retry_feedback: string | undefined
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const independently_verified = await extractIndependentComponentEvidence({
          context,
          job_dir,
          signal: cancellation_signal,
          append,
          additional_instructions: input.additional_instructions,
          retry_feedback: independent_retry_feedback,
          protected_event_log_file,
          published_event_log_file,
          attempt,
        })
        const intrinsic_errors = [
          ...getComponentEvidenceBlockingReasons(independently_verified.component_evidence),
          ...getFootprintEvidenceErrors(
            independently_verified.component_evidence,
            independently_verified.footprint_plan,
          ),
        ]
        const comparison_errors = [
          ...getIndependentComponentEvidenceErrors(
            component_evidence,
            independently_verified.component_evidence,
          ),
          ...getTypicalApplicationPlanAgreementErrors(
            typical_application_plan,
            independently_verified.application_plan,
            component_evidence.part_number.value,
          ),
        ]
        const agreement_errors = [...intrinsic_errors, ...comparison_errors]
        if (agreement_errors.length === 0) {
          independent_evidence_approved = true
          break
        }
        if (attempt < 2) {
          // Preserve independence: only return defects found within this extraction.
          // Cross-extraction differences are logged, but the next verifier must
          // perform another fresh read rather than being told the primary answer.
          independent_retry_feedback = intrinsic_errors.length > 0 ? intrinsic_errors.join("; ") : undefined
          await append(
            "system",
            `Independent evidence attempt ${attempt} did not converge (${agreement_errors.join("; ")}). Retrying with another independent verification…\n`,
          )
          continue
        }
        throw new AutomatedConversionUnavailableError(
          `Independent datasheet evidence did not converge automatically: ${agreement_errors.join("; ")}`,
        )
      } catch (error) {
        if (attempt < 2 && canRetryEvidenceFailure(error)) {
          const reason = error instanceof Error ? error.message : String(error)
          independent_retry_feedback = reason
          await append(
            "system",
            `Independent evidence attempt ${attempt} could not complete (${reason}). Retrying verification automatically…\n`,
          )
          continue
        }
        if (canRetryEvidenceFailure(error) && !(error instanceof AutomatedConversionUnavailableError)) {
          const reason = error instanceof Error ? error.message : String(error)
          throw new AutomatedConversionUnavailableError(
            `Independent evidence extraction could not complete after ${attempt} attempt(s): ${reason}`,
          )
        }
        throw error
      }
    }
    if (!independent_evidence_approved) {
      updateValidation({ evidence: "unresolved" })
      throw new AutomatedConversionUnavailableError(
        "Independent datasheet evidence produced no automatically approved result",
      )
    }
    const component_schematic_plan = createComponentSchematicPlan(component_evidence)
    const component_schematic_plan_text = `${JSON.stringify(component_schematic_plan, null, 2)}\n`
    await Bun.write(component_schematic_plan_path, component_schematic_plan_text)
    const locked_visual_references = await snapshotProtectedTree(join(job_dir, "visual-reference"))
    updateValidation({ evidence: "passed" })
    await append(
      "system",
      "Evidence approved. The primary evidence is locked; the independent artifacts are retained for audit.\n",
    )

    throwIfCancelled(cancellation_signal)
    active_validation_phase = "component_generation"
    await append("system", "\nGenerating the component from approved evidence only…\n")
    let evidence_files_modified = false
    let component_events: TrustedAgentEvent[] = []
    const component_workspace = await prepareGenerationWorkspace(job_dir, "component")
    try {
      component_events = await runStructuredAgentPhase({
        context,
        prompt: buildComponentPrompt(input.additional_instructions),
        cwd: component_workspace.directory,
        signal: cancellation_signal,
        append,
        event_log_file: protected_event_log_file,
        event_publish_file: published_event_log_file,
        event_phase: "component_generation",
      })
    } finally {
      try {
        if (await generationWorkspaceWasModified(component_workspace)) {
          evidence_files_modified = true
        }
        await publishGenerationWorkspace(component_workspace, job_dir, "component")
      } finally {
        await rm(component_workspace.directory, { recursive: true, force: true })
      }
      const [
        current_evidence,
        current_schematic_plan,
        current_footprint,
        current_application_plan,
        visual_references_modified,
      ] = await Promise.all([
        readFile(component_evidence_path, "utf8").catch(() => undefined),
        readFile(component_schematic_plan_path, "utf8").catch(() => undefined),
        readFile(footprint_plan_path, "utf8").catch(() => undefined),
        readFile(typical_application_plan_path, "utf8").catch(() => undefined),
        restoreProtectedTree(join(job_dir, "visual-reference"), locked_visual_references),
      ])
      if (visual_references_modified) evidence_files_modified = true
      if (current_evidence !== component_evidence_text) {
        evidence_files_modified = true
        await Bun.write(component_evidence_path, component_evidence_text)
      }
      if (current_schematic_plan !== component_schematic_plan_text) {
        evidence_files_modified = true
        await Bun.write(component_schematic_plan_path, component_schematic_plan_text)
      }
      if (current_footprint !== footprint_plan_text) {
        evidence_files_modified = true
        await Bun.write(footprint_plan_path, footprint_plan_text)
      }
      if (current_application_plan !== typical_application_plan_text) {
        evidence_files_modified = true
        await Bun.write(typical_application_plan_path, typical_application_plan_text)
      }
    }
    if (evidence_files_modified) {
      throw new Error("The component generation phase modified locked evidence; the server restored it")
    }
    assertNoDatasheetAccess(component_events, "Component generation")
    const component_visual_inspection = await validateVisualInspection({
      job_dir,
      events: component_events,
      report_file: "component-visual-inspection.json",
      build_command: "tsci build index.circuit.tsx",
      expected_images: {
        reference: "visual-reference/land-pattern.png",
        pcb: "dist/index/pcb.png",
        schematic: "dist/index/schematic.png",
      },
    })
    if (component_visual_inspection.status !== "passed") {
      updateValidation({ component_visual: "inconclusive" })
      throw new VisualInspectionInconclusiveError(
        "Component image inspection could not be completed automatically",
      )
    }
    updateValidation({ component_visual: "passed" })
    const component_code = await readFile(component_path, "utf8")
    if (!component_code.includes("export default")) {
      throw new Error("The agent did not create a default-exported TSX component")
    }

    context.job_store.updateJob(input.job_id, { display_status: "building" })
    await append("system", "\nBuilding the generated component with tsci…\n")
    const component_build = await buildCircuitArtifact({
      source_file: "index.circuit.tsx",
      output_stem: "index",
      job_dir,
      tsci_bin: context.tsci_bin,
      signal: cancellation_signal,
      append,
      render_outputs: true,
    })
    if (component_build.errors.length > 0) {
      updateValidation({ component_build: "failed" })
      context.job_store.updateJob(input.job_id, {
        component_code,
        circuit_json: component_build.circuit_json,
      })
      throw new Error(
        `Generated component failed clean build validation: ${component_build.errors.join("; ")}`,
      )
    }
    updateValidation({ component_build: "passed" })
    const component_circuit_json = component_build.circuit_json
    const footprint_errors = getFootprintPlanErrors(footprint_plan, component_circuit_json)
    if (footprint_errors.length > 0) {
      updateValidation({ footprint: "failed" })
      context.job_store.updateJob(input.job_id, {
        component_code,
        circuit_json: component_circuit_json,
      })
      throw new Error(
        `Generated component failed datasheet footprint validation: ${footprint_errors.join("; ")}`,
      )
    }
    updateValidation({ footprint: "passed" })
    const pinout_errors = getPinoutEvidenceErrors(component_evidence, component_circuit_json)
    if (pinout_errors.length > 0) {
      updateValidation({ pinout: "failed" })
      context.job_store.updateJob(input.job_id, {
        component_code,
        circuit_json: component_circuit_json,
      })
      throw new Error(
        `Generated component failed datasheet pin-table validation: ${pinout_errors.join("; ")}`,
      )
    }
    updateValidation({ pinout: "passed" })
    const component_schematic_errors = getComponentSchematicPlanErrors(
      component_schematic_plan,
      component_circuit_json,
    )
    if (component_schematic_errors.length > 0) {
      updateValidation({ component_schematic: "failed" })
      context.job_store.updateJob(input.job_id, {
        component_code,
        circuit_json: component_circuit_json,
      })
      throw new Error(
        `Generated component failed deterministic schematic validation: ${component_schematic_errors.join("; ")}`,
      )
    }
    updateValidation({ component_schematic: "passed" })
    await append(
      "system",
      "Validating the reusable component on a server-owned board with tsci placement DRC…\n",
    )
    const component_validation_build = await buildComponentValidationBoard({
      job_dir,
      tsci_bin: context.tsci_bin,
      signal: cancellation_signal,
      append,
    })
    if (component_validation_build.errors.length > 0) {
      updateValidation({ component_drc: "failed" })
      context.job_store.updateJob(input.job_id, {
        component_code,
        circuit_json: component_circuit_json,
      })
      throw new Error(
        `Generated component failed board-level tsci validation: ${component_validation_build.errors.join(
          "; ",
        )}`,
      )
    }
    updateValidation({ component_drc: "passed" })
    const component_snapshot_path = join(job_dir, "component.circuit.tsx")
    await Bun.write(component_snapshot_path, component_code)

    await append(
      "system",
      "Component ready. Its code, schematic, and PCB are available; SPICE generation may proceed while the typical application is created.\n",
    )
    context.job_store.updateJob(input.job_id, {
      display_status: "agent_running",
      is_complete: false,
      has_errors: false,
      component_ready: true,
      component_code,
      circuit_json: component_circuit_json,
    })

    if (typical_application_plan.availability === "not_present") {
      updateValidation({
        application_build: "not_applicable",
        application_connectivity: "not_applicable",
        application_schematic: "not_applicable",
        application_visual: "not_applicable",
      })
      await append(
        "system",
        "No datasheet typical application was found by either evidence pass. Completing with the validated component only.\n",
      )
      context.job_store.updateJob(input.job_id, {
        display_status: "complete",
        is_complete: true,
        has_errors: false,
        completed_at: new Date().toISOString(),
        component_ready: true,
      })
      return
    }

    throwIfCancelled(cancellation_signal)
    active_validation_phase = "application_generation"
    await append("system", "\nStarting the typical-application phase after the component-ready milestone…\n")
    let protected_files_modified = false
    let application_events: TrustedAgentEvent[] = []
    const application_workspace = await prepareGenerationWorkspace(job_dir, "application")
    try {
      application_events = await runStructuredAgentPhase({
        context,
        prompt: buildTypicalApplicationPrompt(input.additional_instructions),
        cwd: application_workspace.directory,
        signal: cancellation_signal,
        append,
        event_log_file: protected_event_log_file,
        event_publish_file: published_event_log_file,
        event_phase: "typical_application_generation",
      })
    } finally {
      try {
        if (await generationWorkspaceWasModified(application_workspace)) {
          protected_files_modified = true
        }
        await publishGenerationWorkspace(application_workspace, job_dir, "application")
      } finally {
        await rm(application_workspace.directory, { recursive: true, force: true })
      }
      const [
        current_component_code,
        current_component_snapshot,
        current_evidence_text,
        current_schematic_plan_text,
        current_plan_text,
        current_footprint_text,
        visual_references_modified,
      ] = await Promise.all([
        readFile(component_path, "utf8").catch(() => undefined),
        readFile(component_snapshot_path, "utf8").catch(() => undefined),
        readFile(component_evidence_path, "utf8").catch(() => undefined),
        readFile(component_schematic_plan_path, "utf8").catch(() => undefined),
        readFile(typical_application_plan_path, "utf8").catch(() => undefined),
        readFile(footprint_plan_path, "utf8").catch(() => undefined),
        restoreProtectedTree(join(job_dir, "visual-reference"), locked_visual_references),
      ])
      if (visual_references_modified) protected_files_modified = true
      if (current_component_code !== component_code) {
        const server_published_component = context.job_store.getJob(input.job_id)?.component_code
        if (current_component_code !== server_published_component) protected_files_modified = true
        await Bun.write(component_path, component_code)
      }
      if (current_component_snapshot !== component_code) {
        protected_files_modified = true
        await Bun.write(component_snapshot_path, component_code)
      }
      if (current_evidence_text !== component_evidence_text) {
        protected_files_modified = true
        await Bun.write(component_evidence_path, component_evidence_text)
      }
      if (current_schematic_plan_text !== component_schematic_plan_text) {
        protected_files_modified = true
        await Bun.write(component_schematic_plan_path, component_schematic_plan_text)
      }
      if (current_plan_text !== typical_application_plan_text) {
        protected_files_modified = true
        await Bun.write(typical_application_plan_path, typical_application_plan_text)
      }
      if (current_footprint_text !== footprint_plan_text) {
        protected_files_modified = true
        await Bun.write(footprint_plan_path, footprint_plan_text)
      }
    }
    if (protected_files_modified) {
      throw new Error(
        "The typical-application phase modified a read-only component or evidence plan; the server restored it",
      )
    }
    throwIfCancelled(cancellation_signal)
    assertNoDatasheetAccess(application_events, "Typical-application generation")

    const typical_application_path = join(job_dir, "typical-application.circuit.tsx")
    const typical_application_code = await readFile(typical_application_path, "utf8")
    if (
      !typical_application_code.includes("export default") ||
      !importsGeneratedComponent(typical_application_code)
    ) {
      throw new Error(
        "The agent did not create a default-exported typical application importing ./index.circuit",
      )
    }
    const source_schematic_errors = getTypicalApplicationSourceErrors(typical_application_code)
    if (source_schematic_errors.length > 0) {
      updateValidation({ application_schematic: "failed" })
      context.job_store.updateJob(input.job_id, { typical_application_code })
      throw new Error(
        `Typical application failed schematic source validation: ${source_schematic_errors.join("; ")}`,
      )
    }

    const application_visual_inspection = await validateVisualInspection({
      job_dir,
      events: application_events,
      report_file: "application-visual-inspection.json",
      build_command: "tsci build typical-application.circuit.tsx",
      expected_images: {
        reference: "visual-reference/typical-application.png",
        pcb: "dist/typical-application/pcb.png",
        schematic: "dist/typical-application/schematic.png",
      },
    })
    if (application_visual_inspection.status !== "passed") {
      updateValidation({ application_visual: "inconclusive" })
      throw new VisualInspectionInconclusiveError(
        "Typical-application image inspection could not be completed automatically",
      )
    }
    updateValidation({ application_visual: "passed" })

    context.job_store.updateJob(input.job_id, { display_status: "building" })
    await append("system", "\nBuilding the typical application with tsci…\n")
    const typical_application_build = await buildCircuitArtifact({
      source_file: "typical-application.circuit.tsx",
      output_stem: "typical-application",
      job_dir,
      tsci_bin: context.tsci_bin,
      signal: cancellation_signal,
      append,
      render_outputs: true,
    })
    if (typical_application_build.errors.length > 0) {
      updateValidation({ application_build: "failed" })
      context.job_store.updateJob(input.job_id, {
        typical_application_code,
        typical_application_circuit_json: typical_application_build.circuit_json,
      })
      throw new Error(
        `Typical application failed clean build validation: ${typical_application_build.errors.join("; ")}`,
      )
    }
    updateValidation({ application_build: "passed" })
    const typical_application_circuit_json = typical_application_build.circuit_json
    const application_schematic_advisories = getApplicationSchematicLayoutAdvisories(
      typical_application_circuit_json,
    )
    if (application_schematic_advisories.length > 0) {
      await append(
        "system",
        `Schematic layout advisory (accepted because build, image, and connectivity validation are authoritative): ${application_schematic_advisories.join("; ")}\n`,
      )
    }
    updateValidation({ application_schematic: "passed" })
    const connectivity_errors = [
      ...getTypicalApplicationConnectivityErrors(typical_application_plan, typical_application_circuit_json),
      ...getTypicalApplicationComponentValueErrors(
        typical_application_plan,
        typical_application_circuit_json,
      ),
    ]
    if (connectivity_errors.length > 0) {
      updateValidation({ application_connectivity: "failed" })
      context.job_store.updateJob(input.job_id, {
        typical_application_code,
        typical_application_circuit_json,
      })
      throw new Error(
        `Typical application failed datasheet netlist validation: ${connectivity_errors.join("; ")}`,
      )
    }
    updateValidation({ application_connectivity: "passed" })
    const latest_component_job = context.job_store.getJob(input.job_id)
    const published_component_code = latest_component_job?.component_code ?? component_code
    if (published_component_code !== component_code) {
      await Bun.write(component_path, published_component_code)
    }

    await append(
      "system",
      "Typical application ready. Component and application code, schematic, and PCB previews are available.\n",
    )
    context.job_store.updateJob(input.job_id, {
      display_status: "complete",
      is_complete: true,
      has_errors: false,
      completed_at: new Date().toISOString(),
      component_ready: true,
      typical_application_code,
      typical_application_circuit_json,
    })
  } catch (error) {
    if (error instanceof JobCancelledError || cancellation_signal.aborted) {
      await append("system", "\nCancellation requested. The active job process was stopped.\n").catch(
        () => undefined,
      )
      context.job_store.updateJob(input.job_id, {
        display_status: "cancelled",
        is_complete: true,
        has_errors: false,
        completed_at: new Date().toISOString(),
        error_message: undefined,
      })
      return
    }
    const error_message = error instanceof Error ? error.message : String(error)
    const automatic_stop =
      error instanceof AutomatedConversionUnavailableError ||
      error instanceof VisualInspectionInconclusiveError
    const failed_status =
      error instanceof VisualInspectionInconclusiveError
        ? "inconclusive"
        : automatic_stop
          ? "unresolved"
          : "failed"
    if (active_validation_phase === "evidence" && validation.evidence === "pending") {
      updateValidation({ evidence: failed_status })
    } else if (
      active_validation_phase === "component_generation" &&
      validation.component_visual === "pending" &&
      validation.component_build === "pending"
    ) {
      updateValidation({ component_visual: failed_status })
    } else if (
      active_validation_phase === "application_generation" &&
      validation.application_visual === "pending" &&
      validation.application_build === "pending"
    ) {
      updateValidation({ application_visual: failed_status })
    }
    await append(
      "system",
      automatic_stop
        ? `\nAutomatic conversion stopped safely: ${error_message}\n`
        : `\nConversion failed: ${error_message}\n`,
    ).catch(() => undefined)
    context.job_store.updateJob(input.job_id, {
      display_status: automatic_stop ? "unsupported" : "failed",
      is_complete: true,
      has_errors: !automatic_stop,
      completed_at: new Date().toISOString(),
      error_message,
    })
  } finally {
    await rm(protected_event_directory, { recursive: true, force: true }).catch(() => undefined)
  }
}
