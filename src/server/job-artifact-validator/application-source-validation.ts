import type { AnyCircuitElement } from "circuit-json"
import { CircuitRecord, finiteNumber } from "./footprint-plan-validation"

export interface ExpectedApplicationConnection {
  net: string
  pins: string[]
}

export interface ApplicationConnectivityPlan {
  components: Array<{ reference: string; kind?: string; value?: string }>
  connections: ExpectedApplicationConnection[]
}

export function getTypicalApplicationSourceErrors(source: string): string[] {
  const errors: string[] = []
  if (/<\s*netlabel\b/i.test(source)) {
    errors.push("Typical application source must not instantiate <netlabel> elements")
  }
  return errors
}

export function getApplicationSchematicLayoutAdvisories(circuit_json: AnyCircuitElement[]): string[] {
  const records = circuit_json.map((element) => element as CircuitRecord)
  const advisories: string[] = []
  const component_count = records.filter((record) => record.type === "schematic_component").length
  const maximum_edge_length = Math.max(6, 2.5 * Math.sqrt(Math.max(component_count, 1)))
  for (const [trace_index, trace] of records
    .filter((record) => record.type === "schematic_trace")
    .entries()) {
    if (!Array.isArray(trace.edges)) continue
    for (const [edge_index, edge] of trace.edges.entries()) {
      if (typeof edge !== "object" || edge === null) continue
      const edge_record = edge as Record<string, unknown>
      if (
        typeof edge_record.from !== "object" ||
        edge_record.from === null ||
        typeof edge_record.to !== "object" ||
        edge_record.to === null
      ) {
        continue
      }
      const from = edge_record.from as Record<string, unknown>
      const to = edge_record.to as Record<string, unknown>
      const from_x = finiteNumber(from.x)
      const from_y = finiteNumber(from.y)
      const to_x = finiteNumber(to.x)
      const to_y = finiteNumber(to.y)
      if (from_x === undefined || from_y === undefined || to_x === undefined || to_y === undefined) {
        continue
      }
      const length = Math.hypot(to_x - from_x, to_y - from_y)
      if (length > maximum_edge_length) {
        advisories.push(
          `Application schematic trace ${trace_index + 1} edge ${edge_index + 1} is ${length.toFixed(2)} units long; compact-layout target is ${maximum_edge_length.toFixed(2)} for ${component_count} components`,
        )
      }
    }
  }
  return advisories
}
