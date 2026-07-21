import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  type ComponentEvidence,
  createFootprintPlanFromEvidence,
  parseComponentEvidence,
} from "../component-evidence"
import { type FootprintPlan, validateAgentImageReads } from "../job-artifact-validator"
import { JobRunnerContext, StreamProcessInput } from "./stream-job-process"
import { TypicalApplicationPlan, parseTypicalApplicationPlan } from "./parse-typical-application-plan"
import { runStructuredAgentPhase } from "./run-structured-agent-phase"
import { buildTypicalApplicationEvidenceVerificationPrompt } from "./build-typical-application-evidence-verification-prompt"

export async function retainEvidenceAttemptArtifacts(input: {
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

export async function extractIndependentComponentEvidence(input: {
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
    const component_evidence = parseComponentEvidence(JSON.parse(component_evidence_raw_text))
    const application_plan = parseTypicalApplicationPlan(
      JSON.parse(application_raw_text),
      component_evidence.part_number.value,
    )
    if (application_plan.version !== 4) {
      throw new Error(
        "New independent evidence extraction must use typical-application plan schema version 4",
      )
    }
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
