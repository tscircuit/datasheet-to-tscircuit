import type { AnyCircuitElement } from "circuit-json"
import { ApplicationConnectivityPlan } from "./application-source-validation"
import { CircuitRecord, asRecord } from "./footprint-plan-validation"

const SI_PREFIXES: Record<string, number> = {
  p: 1e-12,
  n: 1e-9,
  u: 1e-6,
  µ: 1e-6,
  m: 1e-3,
  "": 1,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
}

function parseEngineeringValue(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value !== "string") return undefined
  const normalized = value
    .trim()
    .replace(/\s+/g, "")
    .replace(/ohms?|Ω/gi, "")
  const match = normalized.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)([pnuµmkKMG]?)(?:[FfHh])?$/)
  if (!match) return undefined
  const amount = Number(match[1])
  const multiplier = SI_PREFIXES[match[2] ?? ""]
  return Number.isFinite(amount) && multiplier !== undefined ? amount * multiplier : undefined
}

function componentValueField(kind: string): "resistance" | "capacitance" | "inductance" | undefined {
  const normalized = kind.toLowerCase()
  if (normalized.includes("resistor")) return "resistance"
  if (normalized.includes("capacitor")) return "capacitance"
  if (normalized.includes("inductor")) return "inductance"
  return undefined
}

export function getTypicalApplicationComponentValueErrors(
  plan: ApplicationConnectivityPlan,
  circuit_json: AnyCircuitElement[],
): string[] {
  const records = circuit_json.map(asRecord)
  const components_by_name = new Map<string, CircuitRecord>()
  for (const component of records.filter((element) => element.type === "source_component")) {
    if (typeof component.name === "string") components_by_name.set(component.name.toLowerCase(), component)
  }
  const errors: string[] = []
  for (const expected of plan.components) {
    if (!expected.kind || !expected.value) continue
    const field = componentValueField(expected.kind)
    if (!field) continue
    const component = components_by_name.get(expected.reference.toLowerCase())
    if (!component) continue
    const expected_value = parseEngineeringValue(expected.value)
    const actual_value = parseEngineeringValue(component[field])
    if (expected_value === undefined) {
      errors.push(`Expected value ${JSON.stringify(expected.value)} for ${expected.reference} is not numeric`)
      continue
    }
    if (actual_value === undefined) {
      errors.push(`Application component ${expected.reference} has no ${field}`)
      continue
    }
    const relative_error = Math.abs(actual_value - expected_value) / Math.max(Math.abs(expected_value), 1e-18)
    if (relative_error > 0.001) {
      errors.push(
        `Application component ${expected.reference} has ${field} ${actual_value}, expected ${expected.value}`,
      )
    }
  }
  return errors
}
