import { getPadAgreementErrors, normalizePin, normalizeText } from "./get-pad-agreement-errors"
import type { ComponentEvidence } from "./types"

export function getIndependentComponentEvidenceAcceptedDifferences(
  primary: ComponentEvidence,
  independent: ComponentEvidence,
): string[] {
  const primary_ordering_code = primary.ordering_code?.value
  const independent_ordering_code = independent.ordering_code?.value
  if (
    !primary_ordering_code ||
    !independent_ordering_code ||
    normalizeText(primary_ordering_code) === normalizeText(independent_ordering_code)
  ) {
    return []
  }
  return [
    `ordering code differs by a non-material packaging option: ${JSON.stringify(primary_ordering_code)} versus ${JSON.stringify(independent_ordering_code)}; the primary ordering code is retained`,
  ]
}

export function getIndependentComponentEvidenceErrors(
  primary: ComponentEvidence,
  independent: ComponentEvidence,
): string[] {
  const errors: string[] = []
  if (normalizeText(primary.part_number.value) !== normalizeText(independent.part_number.value)) {
    errors.push(
      `part number disagrees: ${JSON.stringify(primary.part_number.value)} versus ${JSON.stringify(independent.part_number.value)}`,
    )
  }
  // Ordering codes can identify packaging options rather than different component
  // geometry. For example, TI's DLAT and DLAR suffixes select different reel
  // quantities for the same DLA package. Package code, pinout, and pad geometry
  // below are the material identity checks for component generation.
  const primary_package_code = primary.package.code?.value
  const independent_package_code = independent.package.code?.value
  if (primary_package_code || independent_package_code) {
    if (
      !primary_package_code ||
      !independent_package_code ||
      normalizeText(primary_package_code) !== normalizeText(independent_package_code)
    ) {
      errors.push(
        `package code disagrees: ${JSON.stringify(primary_package_code ?? "missing")} versus ${JSON.stringify(independent_package_code ?? "missing")}`,
      )
    }
  } else if (normalizeText(primary.package.name.value) !== normalizeText(independent.package.name.value)) {
    errors.push(
      `package name disagrees without an exact package code: ${JSON.stringify(primary.package.name.value)} versus ${JSON.stringify(independent.package.name.value)}`,
    )
  }
  if (primary.package.pin_count.value !== independent.package.pin_count.value) {
    errors.push(
      `pin count disagrees: ${primary.package.pin_count.value} versus ${independent.package.pin_count.value}`,
    )
  }
  if (primary.footprint.drawing_orientation.value !== independent.footprint.drawing_orientation.value) {
    errors.push(
      `drawing orientation disagrees: ${primary.footprint.drawing_orientation.value} versus ${independent.footprint.drawing_orientation.value}`,
    )
  }
  const independent_pins = new Map(
    independent.pinout.pins.map((pin) => [normalizePin(pin.number), pin] as const),
  )
  for (const pin of primary.pinout.pins) {
    const other = independent_pins.get(normalizePin(pin.number))
    if (!other) {
      errors.push(`independent evidence is missing pin ${pin.number}`)
      continue
    }
    independent_pins.delete(normalizePin(pin.number))
    const left_labels = new Set(pin.labels.map(normalizeText))
    const right_labels = new Set(other.labels.map(normalizeText))
    if (
      left_labels.size !== right_labels.size ||
      [...left_labels].some((label) => !right_labels.has(label))
    ) {
      errors.push(
        `pin ${pin.number} labels disagree: ${pin.labels.join("/")} versus ${other.labels.join("/")}`,
      )
    }
    const nondirectional_role_pair = new Set([pin.role, other.role])
    const labels_are_switch_nodes = [...left_labels].some((label) => /^(?:l|lx|sw)\d*$/.test(label))
    const roles_agree =
      pin.role === other.role ||
      (labels_are_switch_nodes &&
        nondirectional_role_pair.size === 2 &&
        nondirectional_role_pair.has("passive") &&
        nondirectional_role_pair.has("other"))
    if (!roles_agree) {
      errors.push(`pin ${pin.number} schematic role disagrees: ${pin.role} versus ${other.role}`)
    }
    if (Boolean(pin.electrical_attributes?.open_drain) !== Boolean(other.electrical_attributes?.open_drain)) {
      errors.push(
        `pin ${pin.number} open-drain behavior disagrees: ${Boolean(pin.electrical_attributes?.open_drain)} versus ${Boolean(other.electrical_attributes?.open_drain)}`,
      )
    }
  }
  for (const pin of independent_pins.values())
    errors.push(`independent evidence has unexpected pin ${pin.number}`)
  errors.push(
    ...getPadAgreementErrors({
      evidence_pads: primary.footprint.pads,
      plan_pads: independent.footprint.pads,
      tolerance_mm: 0.005,
    }),
  )
  return errors
}
