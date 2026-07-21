import { join } from "node:path"
import { TypicalApplicationPlan, canonicalizeTypicalApplicationPlan } from "./parse-typical-application-plan"

function normalizedText(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ")
}

export function normalizedIdentifier(value: string | undefined): string {
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

function componentValuesAgree(input: {
  primary_value?: string
  independent_value?: string
  kind: string
  target_part_number?: string
}): boolean {
  const { primary_value, independent_value, kind, target_part_number } = input
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

function getConnectionGroups(plan: TypicalApplicationPlan) {
  return new Map(
    plan.connections.map((connection) => {
      const pins = connection.pins.map(normalizedEndpoint).sort()
      return [JSON.stringify(pins), { net: connection.net, pins }] as const
    }),
  )
}

export function getTypicalApplicationPlanAgreementErrors(input: {
  primary: TypicalApplicationPlan
  independent: TypicalApplicationPlan
  target_part_number?: string
}): string[] {
  let { primary, independent } = input
  const { target_part_number } = input
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
  if (primary.pcb_implementation !== independent.pcb_implementation) {
    errors.push(
      `typical-application PCB implementation disagrees: ${primary.pcb_implementation ?? "missing"} versus ${independent.pcb_implementation ?? "missing"}`,
    )
  }

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
      !componentValuesAgree({
        primary_value: primary_component.value,
        independent_value: independent_component.value,
        kind: primary_kind,
        target_part_number,
      })
    ) {
      errors.push(
        `typical-application component ${primary_component.reference} value disagrees: ${JSON.stringify(primary_component.value ?? "missing")} versus ${JSON.stringify(independent_component.value ?? "missing")}`,
      )
    }
    // U1 identity and geometry are approved independently by component evidence,
    // while a schematic-only application never claims external-part footprints.
    // Only a verified application PCB needs exact agreement on external MPNs and
    // footprints; comparing these optional fields in schematic-only plans makes
    // harmless extraction-detail differences terminal.
    const requires_exact_application_part = primary.pcb_implementation === "verified" && reference !== "u1"
    if (requires_exact_application_part) {
      if (
        normalizedIdentifier(primary_component.manufacturer_part_number) !==
        normalizedIdentifier(independent_component.manufacturer_part_number)
      ) {
        errors.push(
          `typical-application component ${primary_component.reference} manufacturer part number disagrees: ${JSON.stringify(primary_component.manufacturer_part_number ?? "missing")} versus ${JSON.stringify(independent_component.manufacturer_part_number ?? "missing")}`,
        )
      }
      if ((primary_component.footprint ?? "").trim() !== (independent_component.footprint ?? "").trim()) {
        errors.push(
          `typical-application component ${primary_component.reference} footprint disagrees: ${JSON.stringify(primary_component.footprint ?? "missing")} versus ${JSON.stringify(independent_component.footprint ?? "missing")}`,
        )
      }
    }
  }
  for (const independent_component of independent_components.values()) {
    errors.push(`independent typical application has unexpected component ${independent_component.reference}`)
  }

  const independent_connections = getConnectionGroups(independent)
  for (const connection of getConnectionGroups(primary).values()) {
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
