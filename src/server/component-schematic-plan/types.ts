import type { AnyCircuitElement } from "circuit-json"

export type SchematicSide = "left" | "right" | "top" | "bottom"

export type SchematicSideDirection = "top-to-bottom" | "left-to-right"

export interface ComponentSchematicPlan {
  version: 1
  generated_from: "component-evidence-v1"
  schPinArrangement: {
    leftSide: { direction: "top-to-bottom"; pins: string[] }
    rightSide: { direction: "top-to-bottom"; pins: string[] }
    topSide: { direction: "left-to-right"; pins: string[] }
    bottomSide: { direction: "left-to-right"; pins: string[] }
  }
}

export type CircuitRecord = AnyCircuitElement & Record<string, unknown>
