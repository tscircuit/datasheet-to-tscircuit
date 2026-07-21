import type { AnyCircuitElement } from "circuit-json"
import ts from "typescript"
import { CircuitRecord, finiteNumber } from "./footprint-plan-validation"

export interface ExpectedApplicationConnection {
  net: string
  pins: string[]
}

export interface ApplicationConnectivityPlan {
  components: Array<{
    reference: string
    kind?: string
    value?: string
    manufacturer_part_number?: string
    footprint?: string
  }>
  connections: ExpectedApplicationConnection[]
}

export function getTypicalApplicationSourceErrors(
  source: string,
  pcb_implementation: "verified" | "schematic_only" = "verified",
  plan?: ApplicationConnectivityPlan,
): string[] {
  const errors: string[] = []
  if (/<\s*netlabel\b/i.test(source)) {
    errors.push("Typical application source must not instantiate <netlabel> elements")
  }
  if (pcb_implementation === "schematic_only" && /\bfootprint\s*=/.test(source)) {
    errors.push("Schematic-only typical application source must not assign PCB footprints")
  }
  if (pcb_implementation === "schematic_only" && /\bpcb(?:X|Y|Rotation|Layer)\s*=/.test(source)) {
    errors.push("Schematic-only typical application source must not assign PCB placement props")
  }
  if (plan) {
    const component_props = getLiteralJsxComponentProps(source)
    for (const component of plan.components) {
      if (component.reference.trim().toLowerCase() === "u1") continue
      const requires_part_number = Boolean(component.manufacturer_part_number)
      if (pcb_implementation !== "verified" && !requires_part_number) continue
      const props = component_props.get(component.reference.trim().toLowerCase())
      if (!props) {
        errors.push(
          pcb_implementation === "verified"
            ? `Verified PCB component ${component.reference} must be instantiated with a literal name prop`
            : `Application component ${component.reference} with a recorded manufacturer part number must be instantiated with a literal name prop`,
        )
        continue
      }
      if (
        component.manufacturer_part_number &&
        props.manufacturerPartNumber !== component.manufacturer_part_number
      ) {
        errors.push(
          pcb_implementation === "verified"
            ? `Verified PCB component ${component.reference} must set literal manufacturerPartNumber=${JSON.stringify(component.manufacturer_part_number)}`
            : `Application component ${component.reference} must set literal manufacturerPartNumber=${JSON.stringify(component.manufacturer_part_number)}`,
        )
      }
      if (
        pcb_implementation === "verified" &&
        component.footprint &&
        props.footprint !== component.footprint
      ) {
        errors.push(
          `Verified PCB component ${component.reference} must set literal footprint=${JSON.stringify(component.footprint)}`,
        )
      }
    }
  }
  return errors
}

function getLiteralJsxAttribute(node: ts.JsxOpeningLikeElement, attribute_name: string): string | undefined {
  const attribute = node.attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText() === attribute_name,
  )
  const initializer = attribute?.initializer
  if (!initializer) return undefined
  if (ts.isStringLiteral(initializer)) return initializer.text
  const expression = ts.isJsxExpression(initializer) ? initializer.expression : undefined
  return expression && (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
    ? expression.text
    : undefined
}

function getLiteralJsxComponentProps(source: string): Map<string, Record<string, string | undefined>> {
  const source_file = ts.createSourceFile(
    "typical-application.circuit.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  const components = new Map<string, Record<string, string | undefined>>()
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const name = getLiteralJsxAttribute(node, "name")
      if (name) {
        components.set(name.trim().toLowerCase(), {
          manufacturerPartNumber: getLiteralJsxAttribute(node, "manufacturerPartNumber"),
          footprint: getLiteralJsxAttribute(node, "footprint"),
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source_file)
  return components
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
