import { join } from "node:path"
import type { ComponentEvidence } from "../component-evidence"
import {
  getComponentEvidenceBlockingReasons,
  getFootprintEvidenceErrors,
  getIndependentComponentEvidenceErrors,
} from "../component-evidence"
import { createComponentSchematicPlan, type ComponentSchematicPlan } from "../component-schematic-plan"
import type { FootprintPlan } from "../job-artifact-validator"
import { extractIndependentComponentEvidence } from "./extract-independent-component-evidence"
import {
  type PrimaryEvidenceExtraction,
  canRetryEvidenceFailure,
  extractPrimaryEvidenceAttempt,
} from "./extract-primary-evidence-attempt"
import { retainEvidenceAttemptArtifacts } from "./extract-independent-component-evidence"
import { getTypicalApplicationPlanAgreementErrors } from "./get-typical-application-plan-agreement-errors"
import { snapshotProtectedTree } from "./generation-workspace"
import { JobExecution } from "./job-execution"
import type { TypicalApplicationPlan } from "./parse-typical-application-plan"
import { AutomatedConversionUnavailableError, throwIfCancelled } from "./stream-job-process"

export interface ApprovedJobEvidence {
  component_evidence: ComponentEvidence
  component_evidence_text: string
  component_schematic_plan: ComponentSchematicPlan
  component_schematic_plan_text: string
  footprint_plan: FootprintPlan
  footprint_plan_text: string
  typical_application_plan: TypicalApplicationPlan
  typical_application_plan_text: string
  locked_visual_references: Map<string, Buffer>
}

async function extractPrimaryEvidence(execution: JobExecution): Promise<PrimaryEvidenceExtraction> {
  const component_evidence_path = join(execution.job_dir, "component-evidence.json")
  const component_path = join(execution.job_dir, "index.circuit.tsx")
  const starter_component_code = await Bun.file(component_path)
    .text()
    .catch(() => undefined)
  let primary_retry_feedback: string | undefined

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const primary_evidence = await extractPrimaryEvidenceAttempt({
        context: execution.context,
        job_dir: execution.job_dir,
        signal: execution.cancellation_signal,
        append: execution.append.bind(execution),
        additional_instructions: execution.additional_instructions,
        retry_feedback: primary_retry_feedback,
        protected_event_log_file: execution.protected_event_log_file,
        published_event_log_file: execution.published_event_log_file,
        starter_component_code,
        attempt,
      })
      await retainEvidenceAttemptArtifacts({
        source_dir: execution.job_dir,
        job_dir: execution.job_dir,
        kind: "primary",
        attempt,
      })
      return primary_evidence
    } catch (error) {
      await retainEvidenceAttemptArtifacts({
        source_dir: execution.job_dir,
        job_dir: execution.job_dir,
        kind: "primary",
        attempt,
        error,
      })
      const evidence_available = await Bun.file(component_evidence_path).exists()
      execution.context.job_store.updateJob(execution.job_id, { evidence_available })
      if (attempt < 2 && canRetryEvidenceFailure(error)) {
        const reason = error instanceof Error ? error.message : String(error)
        primary_retry_feedback = reason
        await execution.append(
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
  throw new AutomatedConversionUnavailableError("Automatic evidence extraction produced no usable result")
}

async function verifyEvidenceIndependently(
  primary_evidence: PrimaryEvidenceExtraction,
  execution: JobExecution,
): Promise<void> {
  let independent_retry_feedback: string | undefined
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const independently_verified = await extractIndependentComponentEvidence({
        context: execution.context,
        job_dir: execution.job_dir,
        signal: execution.cancellation_signal,
        append: execution.append.bind(execution),
        additional_instructions: execution.additional_instructions,
        retry_feedback: independent_retry_feedback,
        protected_event_log_file: execution.protected_event_log_file,
        published_event_log_file: execution.published_event_log_file,
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
          primary_evidence.component_evidence,
          independently_verified.component_evidence,
        ),
        ...getTypicalApplicationPlanAgreementErrors({
          primary: primary_evidence.typical_application_plan,
          independent: independently_verified.application_plan,
          target_part_number: primary_evidence.component_evidence.part_number.value,
        }),
      ]
      const agreement_errors = [...intrinsic_errors, ...comparison_errors]
      if (agreement_errors.length === 0) return
      if (attempt < 2) {
        independent_retry_feedback = intrinsic_errors.length > 0 ? intrinsic_errors.join("; ") : undefined
        await execution.append(
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
        await execution.append(
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
  execution.updateValidation({ evidence: "unresolved" })
  throw new AutomatedConversionUnavailableError(
    "Independent datasheet evidence produced no automatically approved result",
  )
}

export async function runEvidencePhase(execution: JobExecution): Promise<ApprovedJobEvidence> {
  throwIfCancelled(execution.cancellation_signal)
  await execution.append(
    "system",
    "Starting the evidence-only extraction phase; no circuit code will be generated until the evidence agrees…\n",
  )
  const primary_evidence = await extractPrimaryEvidence(execution)
  execution.context.job_store.updateJob(execution.job_id, { evidence_available: true })

  throwIfCancelled(execution.cancellation_signal)
  await execution.append(
    "system",
    "\nRunning an independent extraction pass; critical evidence must agree before code generation…\n",
  )
  await verifyEvidenceIndependently(primary_evidence, execution)

  const component_schematic_plan = createComponentSchematicPlan(primary_evidence.component_evidence)
  const component_schematic_plan_text = `${JSON.stringify(component_schematic_plan, null, 2)}\n`
  await Bun.write(join(execution.job_dir, "component-schematic-plan.json"), component_schematic_plan_text)
  const locked_visual_references = await snapshotProtectedTree(join(execution.job_dir, "visual-reference"))
  execution.updateValidation({ evidence: "passed" })
  await execution.append(
    "system",
    "Evidence approved. The primary evidence is locked; the independent artifacts are retained for audit.\n",
  )
  return {
    component_evidence: primary_evidence.component_evidence,
    component_evidence_text: primary_evidence.component_evidence_text,
    component_schematic_plan,
    component_schematic_plan_text,
    footprint_plan: primary_evidence.footprint_plan,
    footprint_plan_text: primary_evidence.footprint_plan_text,
    typical_application_plan: primary_evidence.typical_application_plan,
    typical_application_plan_text: primary_evidence.typical_application_plan_text,
    locked_visual_references,
  }
}
