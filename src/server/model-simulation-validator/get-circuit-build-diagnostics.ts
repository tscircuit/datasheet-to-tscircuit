import type { AnyCircuitElement } from "circuit-json"
import { isRecord } from "./parse-simulation-definition"
import { CircuitBuildDiagnostics } from "./types"

export function isCircuitJson(value: unknown): value is AnyCircuitElement[] {
  return (
    Array.isArray(value) &&
    value.every(
      (element) => typeof element === "object" && element !== null && typeof element.type === "string",
    )
  )
}

function normalizeCircuitErrorMessage(element: Record<string, unknown>): string {
  const raw = typeof element.message === "string" ? element.message : String(element.type)
  return raw.split(/\s+Details:\s+Props:/i)[0]!.trim()
}

export function getAllCircuitErrors(value: unknown): string[] {
  if (!isCircuitJson(value)) throw new Error("build did not produce Circuit JSON")
  const errors = new Set<string>()
  for (const element of value) {
    if (!isRecord(element) || typeof element.type !== "string" || !element.type.endsWith("_error")) {
      continue
    }
    errors.add(`${element.type}: ${normalizeCircuitErrorMessage(element)}`)
  }
  return [...errors]
}

export function getCircuitBuildDiagnostics(value: unknown): CircuitBuildDiagnostics {
  if (!isCircuitJson(value)) throw new Error("simulation did not produce Circuit JSON")
  const source_errors = new Set<string>()
  const simulation_errors = new Set<string>()
  for (const element of value) {
    if (!isRecord(element) || typeof element.type !== "string" || !element.type.endsWith("_error")) continue
    const message = normalizeCircuitErrorMessage(element)
    if (element.type.startsWith("source_")) source_errors.add(message)
    if (element.type.startsWith("simulation_")) simulation_errors.add(message)
  }
  return { source_errors: [...source_errors], simulation_errors: [...simulation_errors] }
}
