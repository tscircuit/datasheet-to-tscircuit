import type { AnyCircuitElement } from "circuit-json"
import { ComponentEvidence } from "./types"
import { CircuitRecord } from "./parse-component-evidence"
import { normalizePin, normalizeText } from "./get-pad-agreement-errors"

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

export function getPinoutEvidenceErrors(
  evidence: ComponentEvidence,
  circuit_json: AnyCircuitElement[],
): string[] {
  const ports = circuit_json
    .map((element) => element as CircuitRecord)
    .filter((element) => element.type === "source_port")
  const unmatched = new Set(ports.map((_, index) => index))
  const errors: string[] = []
  for (const pin of evidence.pinout.pins) {
    const expected_number = normalizePin(pin.number)
    const candidates = [...unmatched].filter((index) => {
      const port = ports[index]!
      const number_aliases = [
        typeof port.pin_number === "number" || typeof port.pin_number === "string"
          ? String(port.pin_number)
          : "",
        ...asStringArray(port.port_hints),
      ]
      return number_aliases.some((alias) => normalizePin(alias) === expected_number)
    })
    if (candidates.length !== 1) {
      errors.push(`evidence pin ${pin.number} resolved to ${candidates.length} Circuit JSON ports`)
      continue
    }
    const selected_index = candidates[0]!
    unmatched.delete(selected_index)
    const port = ports[selected_index]!
    const actual_labels = [
      typeof port.name === "string" ? port.name : "",
      ...asStringArray(port.port_hints),
    ].map(normalizeText)
    if (!pin.labels.map(normalizeText).every((label) => actual_labels.includes(label))) {
      errors.push(`pin ${pin.number} labels ${pin.labels.join("/")} are absent from its Circuit JSON port`)
    }
  }
  for (const index of unmatched) {
    const port = ports[index]!
    errors.push(
      `Circuit JSON has unexpected source port ${String(port.name ?? port.pin_number ?? index + 1)}`,
    )
  }
  return errors
}
