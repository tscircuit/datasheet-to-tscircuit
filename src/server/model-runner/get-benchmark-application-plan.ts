import { readFile } from "node:fs/promises"
import {
  getTypicalApplicationComponentValueErrors,
  getTypicalApplicationConnectivityErrors,
  type ApplicationConnectivityPlan,
} from "../job-artifact-validator"
import { type TypicalApplicationPlan } from "../job-runner"
import { isCircuitJson } from "./attach-model-to-generated-component"

export function getStubComponentPins(input: {
  component_circuit_json: unknown
  component_source: string
}): Array<{ component_pin: string; spice_node: string }> {
  const pins_by_number = new Map<number, { component_pin: string; spice_node: string }>()
  if (isCircuitJson(input.component_circuit_json)) {
    for (const element of input.component_circuit_json) {
      if (element.type !== "source_port" || !("pin_number" in element)) continue
      const pin_number = element.pin_number
      if (typeof pin_number !== "number" || !Number.isInteger(pin_number) || pin_number < 1) continue
      pins_by_number.set(pin_number, {
        component_pin: `pin${pin_number}`,
        spice_node: `P${pin_number}`,
      })
    }
  }
  if (pins_by_number.size === 0) {
    for (const match of input.component_source.matchAll(/\bpin(\d+)\b/gi)) {
      const pin_number = Number(match[1])
      if (!Number.isInteger(pin_number) || pin_number < 1) continue
      pins_by_number.set(pin_number, {
        component_pin: `pin${pin_number}`,
        spice_node: `P${pin_number}`,
      })
    }
  }
  if (pins_by_number.size === 0) {
    pins_by_number.set(1, { component_pin: "pin1", spice_node: "P1" })
    pins_by_number.set(2, { component_pin: "pin2", spice_node: "P2" })
  }
  return [...pins_by_number.entries()].sort(([left], [right]) => left - right).map(([, pin]) => pin)
}

export function inferApplicationDutReference(plan: TypicalApplicationPlan): string {
  const endpoint_counts = new Map<string, number>()
  for (const connection of plan.connections) {
    for (const endpoint of connection.pins) {
      const reference = endpoint.slice(0, endpoint.indexOf("."))
      endpoint_counts.set(reference.toLowerCase(), (endpoint_counts.get(reference.toLowerCase()) ?? 0) + 1)
    }
  }
  const scored = plan.components.map((component, index) => ({
    reference: component.reference,
    score:
      (endpoint_counts.get(component.reference.toLowerCase()) ?? 0) * 10 +
      (/^u\d+$/i.test(component.reference) ? 5 : 0) +
      (/\b(?:chip|ic|converter|controller|regulator|sensor|driver)\b/i.test(component.kind) ? 3 : 0) -
      index / 1_000,
  }))
  scored.sort((left, right) => right.score - left.score)
  const reference = scored[0]?.reference
  if (!reference) throw new Error("typical-application-plan.json has no primary DUT component")
  return reference
}

function isBenchmarkControlledDutPort(endpoint: string): boolean {
  const port = endpoint.slice(endpoint.indexOf(".") + 1)
  return /^(?:en|enable|shutdown|shdn|mode|sel\d*|sync|reset|rst|sleep)$/i.test(port)
}

export function getBenchmarkApplicationPlan(plan: TypicalApplicationPlan): ApplicationConnectivityPlan {
  const dut_reference = inferApplicationDutReference(plan)
  const controlled_connections = plan.connections.filter((connection) =>
    connection.pins.some((endpoint) => {
      const separator = endpoint.indexOf(".")
      return (
        endpoint.slice(0, separator).toLowerCase() === dut_reference.toLowerCase() &&
        isBenchmarkControlledDutPort(endpoint)
      )
    }),
  )
  const controlled_external_references = new Set(
    controlled_connections.flatMap((connection) =>
      connection.pins.flatMap((endpoint) => {
        const reference = endpoint.slice(0, endpoint.indexOf("."))
        return reference.toLowerCase() === dut_reference.toLowerCase() ? [] : [reference.toLowerCase()]
      }),
    ),
  )
  const remap_endpoint = (endpoint: string): string => {
    const separator = endpoint.indexOf(".")
    return endpoint.slice(0, separator).toLowerCase() === dut_reference.toLowerCase()
      ? `DUT${endpoint.slice(separator)}`
      : endpoint
  }
  const connections = plan.connections.flatMap((connection) => {
    if (controlled_connections.includes(connection)) return []
    const pins = connection.pins
      .filter((endpoint) => {
        const reference = endpoint.slice(0, endpoint.indexOf(".")).toLowerCase()
        return !controlled_external_references.has(reference)
      })
      .map(remap_endpoint)
    return pins.length >= 2 ? [{ ...connection, pins }] : []
  })
  const required_references = new Set(
    connections.flatMap((connection) =>
      connection.pins.map((endpoint) => endpoint.slice(0, endpoint.indexOf(".")).toLowerCase()),
    ),
  )
  return {
    components: plan.components.flatMap((component) => {
      const reference =
        component.reference.toLowerCase() === dut_reference.toLowerCase() ? "DUT" : component.reference
      return required_references.has(reference.toLowerCase()) ? [{ ...component, reference }] : []
    }),
    connections,
  }
}

export async function getBenchmarkApplicationErrors(
  plan: ApplicationConnectivityPlan,
  circuit_json_path: string,
): Promise<string[]> {
  const circuit_json: unknown = JSON.parse(await readFile(circuit_json_path, "utf8"))
  if (!isCircuitJson(circuit_json)) return ["benchmark build did not produce valid Circuit JSON"]
  return [
    ...getTypicalApplicationConnectivityErrors(plan, circuit_json),
    ...getTypicalApplicationComponentValueErrors(plan, circuit_json),
  ]
}
