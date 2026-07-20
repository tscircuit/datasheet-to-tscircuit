import type { FootprintPlan } from "../job-artifact-validator"
import { ComponentEvidence } from "./types"
import { getPadAgreementErrors } from "./get-pad-agreement-errors"

export function getFootprintEvidenceErrors(evidence: ComponentEvidence, plan: FootprintPlan): string[] {
  const errors = getPadAgreementErrors({
    evidence_pads: evidence.footprint.pads,
    plan_pads: plan.pads,
    tolerance_mm: 0.001,
  })
  const evidence_pages = new Set(
    evidence.footprint.pads.flatMap((pad) => pad.sources.map((source) => source.page)),
  )
  if (
    evidence_pages.size > 0 &&
    !plan.source_references.some((reference) => evidence_pages.has(reference.page))
  ) {
    errors.push("footprint plan does not cite any page used by the pad evidence")
  }
  return errors
}
