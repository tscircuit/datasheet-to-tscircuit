import { cp, rm } from "node:fs/promises"
import { join } from "node:path"
import type { ComponentEvidence } from "../component-evidence"
import {
  getComponentEvidenceBlockingReasons,
  getFootprintEvidenceErrors,
  getIndependentComponentEvidenceAcceptedDifferences,
  getIndependentComponentEvidenceErrors,
} from "../component-evidence"
import { type ComponentSchematicPlan, createComponentSchematicPlan } from "../component-schematic-plan"
import type { FootprintPlan } from "../job-artifact-validator"
import {
  extractIndependentComponentEvidence,
  retainEvidenceAttemptArtifacts,
} from "./extract-independent-component-evidence"
import {
  canRetryEvidenceFailure,
  extractPrimaryEvidenceAttempt,
  type PrimaryEvidenceExtraction,
} from "./extract-primary-evidence-attempt"
import { snapshotProtectedTree } from "./generation-workspace"
import { getTypicalApplicationPlanAgreementErrors } from "./get-typical-application-plan-agreement-errors"
import type { JobExecution } from "./job-execution"
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
): Promise<PrimaryEvidenceExtraction> {
  type IndependentEvidence = Awaited<ReturnType<typeof extractIndependentComponentEvidence>>
  type ValidDisagreement = {
    attempt: number
    evidence: IndependentEvidence
    primary_errors: string[]
  }

  const max_extraction_attempts = 4
  const max_valid_disagreements = 3
  let independent_retry_feedback: string | undefined
  let last_retryable_error: string | undefined
  const valid_disagreements: ValidDisagreement[] = []

  const getPairwiseErrors = (left: IndependentEvidence, right: IndependentEvidence): string[] => [
    ...getIndependentComponentEvidenceErrors(left.component_evidence, right.component_evidence),
    ...getTypicalApplicationPlanAgreementErrors({
      primary: left.application_plan,
      independent: right.application_plan,
      target_part_number: right.component_evidence.part_number.value,
    }),
  ]

  const noConsensusError = (): AutomatedConversionUnavailableError => {
    const comparisons = valid_disagreements.map(
      ({ attempt, primary_errors }) => `primary versus independent-${attempt}: ${primary_errors.join("; ")}`,
    )
    for (let left_index = 0; left_index < valid_disagreements.length; left_index += 1) {
      for (let right_index = left_index + 1; right_index < valid_disagreements.length; right_index += 1) {
        const left = valid_disagreements.at(left_index)
        const right = valid_disagreements.at(right_index)
        if (!left || !right) continue
        const errors = getPairwiseErrors(left.evidence, right.evidence)
        if (errors.length > 0) {
          comparisons.push(
            `independent-${left.attempt} versus independent-${right.attempt}: ${errors.join("; ")}`,
          )
        }
      }
    }
    return new AutomatedConversionUnavailableError(
      `Evidence extracts did not reach consensus after ${valid_disagreements.length} valid independent verification(s): ${comparisons.join("; ")}`,
    )
  }

  for (let attempt = 1; attempt <= max_extraction_attempts; attempt += 1) {
    let independently_verified: IndependentEvidence
    try {
      independently_verified = await extractIndependentComponentEvidence({
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
    } catch (error) {
      if (!canRetryEvidenceFailure(error)) throw error
      const reason = error instanceof Error ? error.message : String(error)
      last_retryable_error = reason
      if (attempt < max_extraction_attempts) {
        independent_retry_feedback = reason
        await execution.append(
          "system",
          `Independent evidence attempt ${attempt} could not complete (${reason}). Retrying verification automatically without consuming a consensus vote…\n`,
        )
        continue
      }
      if (valid_disagreements.length > 0) throw noConsensusError()
      if (error instanceof AutomatedConversionUnavailableError) throw error
      throw new AutomatedConversionUnavailableError(
        `Independent evidence extraction could not complete after ${attempt} attempt(s): ${reason}`,
      )
    }

    const intrinsic_errors = [
      ...getComponentEvidenceBlockingReasons(independently_verified.component_evidence),
      ...getFootprintEvidenceErrors(
        independently_verified.component_evidence,
        independently_verified.footprint_plan,
      ),
    ]
    if (intrinsic_errors.length > 0) {
      const reason = intrinsic_errors.join("; ")
      last_retryable_error = reason
      if (attempt < max_extraction_attempts) {
        independent_retry_feedback = reason
        await execution.append(
          "system",
          `Independent evidence attempt ${attempt} was incomplete (${reason}). Retrying verification automatically without consuming a consensus vote…\n`,
        )
        continue
      }
      break
    }

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
    if (comparison_errors.length === 0) {
      const accepted_differences = getIndependentComponentEvidenceAcceptedDifferences(
        primary_evidence.component_evidence,
        independently_verified.component_evidence,
      )
      for (const difference of accepted_differences) {
        await execution.append("system", `Accepted evidence difference: ${difference}.\n`)
      }
      if (valid_disagreements.length > 0) {
        await execution.append(
          "system",
          `Evidence consensus recovered on independent attempt ${attempt}; the primary extraction is retained.\n`,
        )
      }
      return primary_evidence
    }

    for (const previous of valid_disagreements) {
      if (getPairwiseErrors(previous.evidence, independently_verified).length === 0) {
        const promoted = await promoteIndependentConsensus({
          execution,
          independently_verified,
        })
        await execution.append(
          "system",
          `Independent evidence consensus overrode the primary extraction after ${attempt} extraction attempt(s) (${comparison_errors.join("; ")}). Recovery matched independent attempts ${previous.attempt} and ${attempt}; their canonical evidence is retained for generation.\n`,
        )
        return promoted
      }
    }

    valid_disagreements.push({
      attempt,
      evidence: independently_verified,
      primary_errors: comparison_errors,
    })
    if (valid_disagreements.length >= max_valid_disagreements) throw noConsensusError()

    independent_retry_feedback =
      valid_disagreements.length === 1
        ? "A prior independent extraction disagreed with the primary evidence. Perform a fresh extraction without assuming either result."
        : "Multiple valid independent extractions disagree on critical evidence. This is a recovery tie-breaker. Re-inspect the original datasheet pixels from scratch, concentrate on dimension-leader endpoints and calculated pad centers, and do not average prior values."
    await execution.append(
      "system",
      valid_disagreements.length === 1
        ? `Independent evidence attempt ${attempt} disagreed with the primary extraction (${comparison_errors.join("; ")}). Retrying with another independent verification…\n`
        : `Independent evidence remains split after attempt ${attempt} (${comparison_errors.join("; ")}). Running a recovery tie-breaker verification…\n`,
    )
  }

  if (valid_disagreements.length > 0) throw noConsensusError()
  throw new AutomatedConversionUnavailableError(
    `Independent evidence extraction could not produce a valid verification after ${max_extraction_attempts} attempt(s)${last_retryable_error ? `: ${last_retryable_error}` : ""}`,
  )
}

async function promoteIndependentConsensus(input: {
  execution: JobExecution
  independently_verified: Awaited<ReturnType<typeof extractIndependentComponentEvidence>>
}): Promise<PrimaryEvidenceExtraction> {
  const { execution, independently_verified } = input
  const component_evidence_text = `${JSON.stringify(independently_verified.component_evidence, null, 2)}\n`
  const footprint_plan_text = `${JSON.stringify(independently_verified.footprint_plan, null, 2)}\n`
  const typical_application_plan_text = `${JSON.stringify(independently_verified.application_plan, null, 2)}\n`
  await Promise.all([
    Bun.write(join(execution.job_dir, "component-evidence.json"), component_evidence_text),
    Bun.write(join(execution.job_dir, "footprint-plan.json"), footprint_plan_text),
    Bun.write(join(execution.job_dir, "typical-application-plan.json"), typical_application_plan_text),
    cp(
      join(execution.job_dir, "visual-reference", "land-pattern.independent.png"),
      join(execution.job_dir, "visual-reference", "land-pattern.png"),
    ),
    independently_verified.application_plan.availability === "documented"
      ? cp(
          join(execution.job_dir, "visual-reference", "typical-application.independent.png"),
          join(execution.job_dir, "visual-reference", "typical-application.png"),
        )
      : rm(join(execution.job_dir, "visual-reference", "typical-application.png"), { force: true }),
  ])
  return {
    component_evidence: independently_verified.component_evidence,
    component_evidence_text,
    footprint_plan: independently_verified.footprint_plan,
    footprint_plan_text,
    typical_application_plan: independently_verified.application_plan,
    typical_application_plan_text,
  }
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
  const approved_evidence = await verifyEvidenceIndependently(primary_evidence, execution)
  execution.context.job_store.updateJob(execution.job_id, {
    typical_application_title:
      approved_evidence.typical_application_plan.availability === "documented"
        ? approved_evidence.typical_application_plan.title
        : undefined,
  })

  const component_schematic_plan = createComponentSchematicPlan(approved_evidence.component_evidence)
  const component_schematic_plan_text = `${JSON.stringify(component_schematic_plan, null, 2)}\n`
  await Bun.write(join(execution.job_dir, "component-schematic-plan.json"), component_schematic_plan_text)
  const locked_visual_references = await snapshotProtectedTree(join(execution.job_dir, "visual-reference"))
  execution.updateValidation({ evidence: "passed" })
  await execution.append(
    "system",
    "Evidence approved. The consensus-selected evidence is locked; all extraction artifacts are retained for audit.\n",
  )
  return {
    component_evidence: approved_evidence.component_evidence,
    component_evidence_text: approved_evidence.component_evidence_text,
    component_schematic_plan,
    component_schematic_plan_text,
    footprint_plan: approved_evidence.footprint_plan,
    footprint_plan_text: approved_evidence.footprint_plan_text,
    typical_application_plan: approved_evidence.typical_application_plan,
    typical_application_plan_text: approved_evidence.typical_application_plan_text,
    locked_visual_references,
  }
}
