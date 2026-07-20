import type { ExpectedFootprintPad } from "../job-artifact-validator"
import { EvidencePad } from "./types"

export function normalizeText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
}

export function normalizePin(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^pin(?=[a-z]*\d+$)/, "")
}

function closeEnough(input: { left: number; right: number; tolerance_mm: number }): boolean {
  return Math.abs(input.left - input.right) <= input.tolerance_mm
}

function getPadDistance(input: { pad: ExpectedFootprintPad; evidence_pad: EvidencePad }): number {
  return (
    Math.abs(input.pad.x - input.evidence_pad.x) +
    Math.abs(input.pad.y - input.evidence_pad.y) +
    Math.abs(input.pad.width - input.evidence_pad.width) +
    Math.abs(input.pad.height - input.evidence_pad.height)
  )
}

export function getPadAgreementErrors(input: {
  evidence_pads: EvidencePad[]
  plan_pads: ExpectedFootprintPad[]
  tolerance_mm: number
}): string[] {
  const { evidence_pads, plan_pads, tolerance_mm } = input
  const errors: string[] = []
  if (evidence_pads.length !== plan_pads.length) {
    errors.push(`evidence has ${evidence_pads.length} pads, but plan has ${plan_pads.length}`)
  }
  const unmatched = new Set(plan_pads.map((_, index) => index))
  for (const evidence_pad of evidence_pads) {
    const candidates = [...unmatched].filter((index) => {
      const plan_pad = plan_pads[index]!
      return (
        ((plan_pad.pin === null && evidence_pad.pin === null) ||
          (plan_pad.pin !== null &&
            evidence_pad.pin !== null &&
            normalizePin(plan_pad.pin) === normalizePin(evidence_pad.pin))) &&
        plan_pad.kind === evidence_pad.kind
      )
    })
    candidates.sort(
      (left, right) =>
        getPadDistance({ pad: plan_pads[left]!, evidence_pad }) -
        getPadDistance({ pad: plan_pads[right]!, evidence_pad }),
    )
    const selected_index = candidates[0]
    if (selected_index === undefined) {
      errors.push(
        evidence_pad.pin === null
          ? `plan is missing unassigned ${evidence_pad.kind} mechanical pad`
          : `plan is missing ${evidence_pad.kind} pad for pin ${evidence_pad.pin}`,
      )
      continue
    }
    unmatched.delete(selected_index)
    const plan_pad = plan_pads[selected_index]!
    const fields = [
      ["x", evidence_pad.x, plan_pad.x],
      ["y", evidence_pad.y, plan_pad.y],
      ["width", evidence_pad.width, plan_pad.width],
      ["height", evidence_pad.height, plan_pad.height],
    ] as const
    if (evidence_pad.kind === "plated_hole") {
      if (
        evidence_pad.hole_width === undefined ||
        plan_pad.hole_width === undefined ||
        !closeEnough({ left: evidence_pad.hole_width, right: plan_pad.hole_width, tolerance_mm })
      ) {
        errors.push(
          `${evidence_pad.pin === null ? "unassigned mechanical pad" : `pin ${evidence_pad.pin}`} hole width differs between evidence and plan`,
        )
      }
      if (
        evidence_pad.hole_height === undefined ||
        plan_pad.hole_height === undefined ||
        !closeEnough({ left: evidence_pad.hole_height, right: plan_pad.hole_height, tolerance_mm })
      ) {
        errors.push(
          `${evidence_pad.pin === null ? "unassigned mechanical pad" : `pin ${evidence_pad.pin}`} hole height differs between evidence and plan`,
        )
      }
    }
    for (const [field, evidence_value, plan_value] of fields) {
      if (!closeEnough({ left: evidence_value, right: plan_value, tolerance_mm })) {
        errors.push(
          `${evidence_pad.pin === null ? "unassigned mechanical pad" : `pin ${evidence_pad.pin}`} ${field} is ${plan_value} mm in plan, expected ${evidence_value} mm`,
        )
      }
    }
  }
  for (const index of unmatched) {
    const pad = plan_pads[index]!
    errors.push(
      pad.pin === null
        ? `plan has unexpected unassigned ${pad.kind} mechanical pad`
        : `plan has unexpected ${pad.kind} pad for pin ${pad.pin}`,
    )
  }
  return errors
}
