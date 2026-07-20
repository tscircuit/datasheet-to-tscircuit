import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import type { TrustedAgentEvent } from "../agent-event-protocol"
import {
  getApplicationSchematicLayoutAdvisories,
  getTypicalApplicationComponentValueErrors,
  getTypicalApplicationConnectivityErrors,
  getTypicalApplicationSourceErrors,
  validateVisualInspection,
  VisualInspectionInconclusiveError,
} from "../job-artifact-validator"
import { buildCircuitArtifact } from "./build-circuit-artifact"
import { buildTypicalApplicationPrompt } from "./build-typical-application-prompt"
import { assertNoDatasheetAccess } from "./get-forbidden-datasheet-accesses"
import {
  generationWorkspaceWasModified,
  importsGeneratedComponent,
  prepareGenerationWorkspace,
  publishGenerationWorkspace,
  restoreProtectedTree,
} from "./generation-workspace"
import { JobExecution } from "./job-execution"
import type { GeneratedComponent } from "./run-component-generation-phase"
import type { ApprovedJobEvidence } from "./run-evidence-phase"
import { runStructuredAgentPhase } from "./run-structured-agent-phase"
import { throwIfCancelled } from "./stream-job-process"

async function restoreApplicationInputs(input: {
  evidence: ApprovedJobEvidence
  component: GeneratedComponent
  execution: JobExecution
}): Promise<boolean> {
  const component_path = join(input.execution.job_dir, "index.circuit.tsx")
  const component_evidence_path = join(input.execution.job_dir, "component-evidence.json")
  const component_schematic_plan_path = join(input.execution.job_dir, "component-schematic-plan.json")
  const typical_application_plan_path = join(input.execution.job_dir, "typical-application-plan.json")
  const footprint_plan_path = join(input.execution.job_dir, "footprint-plan.json")
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
    readFile(input.component.component_snapshot_path, "utf8").catch(() => undefined),
    readFile(component_evidence_path, "utf8").catch(() => undefined),
    readFile(component_schematic_plan_path, "utf8").catch(() => undefined),
    readFile(typical_application_plan_path, "utf8").catch(() => undefined),
    readFile(footprint_plan_path, "utf8").catch(() => undefined),
    restoreProtectedTree(
      join(input.execution.job_dir, "visual-reference"),
      input.evidence.locked_visual_references,
    ),
  ])
  let protected_files_modified = visual_references_modified
  if (current_component_code !== input.component.component_code) {
    const server_published_component = input.execution.context.job_store.getJob(
      input.execution.job_id,
    )?.component_code
    if (current_component_code !== server_published_component) protected_files_modified = true
    await Bun.write(component_path, input.component.component_code)
  }
  if (current_component_snapshot !== input.component.component_code) {
    protected_files_modified = true
    await Bun.write(input.component.component_snapshot_path, input.component.component_code)
  }
  if (current_evidence_text !== input.evidence.component_evidence_text) {
    protected_files_modified = true
    await Bun.write(component_evidence_path, input.evidence.component_evidence_text)
  }
  if (current_schematic_plan_text !== input.evidence.component_schematic_plan_text) {
    protected_files_modified = true
    await Bun.write(component_schematic_plan_path, input.evidence.component_schematic_plan_text)
  }
  if (current_plan_text !== input.evidence.typical_application_plan_text) {
    protected_files_modified = true
    await Bun.write(typical_application_plan_path, input.evidence.typical_application_plan_text)
  }
  if (current_footprint_text !== input.evidence.footprint_plan_text) {
    protected_files_modified = true
    await Bun.write(footprint_plan_path, input.evidence.footprint_plan_text)
  }
  return protected_files_modified
}

export async function runApplicationGenerationPhase(input: {
  evidence: ApprovedJobEvidence
  component: GeneratedComponent
  execution: JobExecution
}): Promise<void> {
  const { evidence, component, execution } = input
  throwIfCancelled(execution.cancellation_signal)
  execution.active_validation_phase = "application_generation"
  await execution.append(
    "system",
    "\nStarting the typical-application phase after the component-ready milestone…\n",
  )
  const application_workspace = await prepareGenerationWorkspace(execution.job_dir, "application")
  let protected_files_modified = false
  let application_events: TrustedAgentEvent[] = []
  try {
    application_events = await runStructuredAgentPhase({
      context: execution.context,
      prompt: buildTypicalApplicationPrompt(execution.additional_instructions),
      cwd: application_workspace.directory,
      signal: execution.cancellation_signal,
      append: execution.append.bind(execution),
      event_log_file: execution.protected_event_log_file,
      event_publish_file: execution.published_event_log_file,
      event_phase: "typical_application_generation",
    })
  } finally {
    try {
      protected_files_modified = await generationWorkspaceWasModified(application_workspace)
      await publishGenerationWorkspace({
        workspace: application_workspace,
        job_dir: execution.job_dir,
        phase: "application",
      })
    } finally {
      await rm(application_workspace.directory, { recursive: true, force: true })
    }
    if (await restoreApplicationInputs(input)) protected_files_modified = true
  }
  if (protected_files_modified) {
    throw new Error(
      "The typical-application phase modified a read-only component or evidence plan; the server restored it",
    )
  }
  throwIfCancelled(execution.cancellation_signal)
  assertNoDatasheetAccess(application_events, "Typical-application generation")

  const typical_application_path = join(execution.job_dir, "typical-application.circuit.tsx")
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
    execution.updateValidation({ application_schematic: "failed" })
    execution.context.job_store.updateJob(execution.job_id, { typical_application_code })
    throw new Error(
      `Typical application failed schematic source validation: ${source_schematic_errors.join("; ")}`,
    )
  }

  const application_visual_inspection = await validateVisualInspection({
    job_dir: execution.job_dir,
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
    execution.updateValidation({ application_visual: "inconclusive" })
    throw new VisualInspectionInconclusiveError(
      "Typical-application image inspection could not be completed automatically",
    )
  }
  execution.updateValidation({ application_visual: "passed" })

  execution.context.job_store.updateJob(execution.job_id, { display_status: "building" })
  await execution.append("system", "\nBuilding the typical application with tsci…\n")
  const typical_application_build = await buildCircuitArtifact({
    source_file: "typical-application.circuit.tsx",
    output_stem: "typical-application",
    job_dir: execution.job_dir,
    tsci_bin: execution.context.tsci_bin,
    signal: execution.cancellation_signal,
    append: execution.append.bind(execution),
    render_outputs: true,
  })
  if (typical_application_build.errors.length > 0) {
    execution.updateValidation({ application_build: "failed" })
    execution.context.job_store.updateJob(execution.job_id, {
      typical_application_code,
      typical_application_circuit_json: typical_application_build.circuit_json,
    })
    throw new Error(
      `Typical application failed clean build validation: ${typical_application_build.errors.join("; ")}`,
    )
  }
  execution.updateValidation({ application_build: "passed" })
  const typical_application_circuit_json = typical_application_build.circuit_json
  const application_schematic_advisories = getApplicationSchematicLayoutAdvisories(
    typical_application_circuit_json,
  )
  if (application_schematic_advisories.length > 0) {
    await execution.append(
      "system",
      `Schematic layout advisory (accepted because build, image, and connectivity validation are authoritative): ${application_schematic_advisories.join("; ")}\n`,
    )
  }
  execution.updateValidation({ application_schematic: "passed" })

  const connectivity_errors = [
    ...getTypicalApplicationConnectivityErrors(
      evidence.typical_application_plan,
      typical_application_circuit_json,
    ),
    ...getTypicalApplicationComponentValueErrors(
      evidence.typical_application_plan,
      typical_application_circuit_json,
    ),
  ]
  if (connectivity_errors.length > 0) {
    execution.updateValidation({ application_connectivity: "failed" })
    execution.context.job_store.updateJob(execution.job_id, {
      typical_application_code,
      typical_application_circuit_json,
    })
    throw new Error(
      `Typical application failed datasheet netlist validation: ${connectivity_errors.join("; ")}`,
    )
  }
  execution.updateValidation({ application_connectivity: "passed" })

  const published_component_code =
    execution.context.job_store.getJob(execution.job_id)?.component_code ?? component.component_code
  if (published_component_code !== component.component_code) {
    await Bun.write(join(execution.job_dir, "index.circuit.tsx"), published_component_code)
  }
  await execution.append(
    "system",
    "Typical application ready. Component and application code, schematic, and PCB previews are available.\n",
  )
  execution.context.job_store.updateJob(execution.job_id, {
    display_status: "complete",
    is_complete: true,
    has_errors: false,
    completed_at: new Date().toISOString(),
    component_ready: true,
    typical_application_code,
    typical_application_circuit_json,
  })
}
