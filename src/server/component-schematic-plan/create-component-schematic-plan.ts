import type { ComponentEvidence, PinEvidence } from "../component-evidence"
import { ComponentSchematicPlan } from "./types"

const pin_collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" })

function sortPins(pins: PinEvidence[]): PinEvidence[] {
  return [...pins].sort((left, right) => pin_collator.compare(left.number, right.number))
}

export function createComponentSchematicPlan(evidence: ComponentEvidence): ComponentSchematicPlan {
  const left: PinEvidence[] = []
  const right: PinEvidence[] = []
  const top: PinEvidence[] = []
  const bottom: PinEvidence[] = []
  const flexible: PinEvidence[] = []

  for (const pin of sortPins(evidence.pinout.pins)) {
    if (pin.role === "power_input") top.push(pin)
    else if (pin.role === "ground") bottom.push(pin)
    else if (pin.role === "input" || pin.role === "no_connect") left.push(pin)
    else if (pin.role === "output" || pin.role === "power_output" || pin.role === "bidirectional") {
      right.push(pin)
    } else {
      flexible.push(pin)
    }
  }

  for (const [index, pin] of flexible.entries()) {
    if (index % 2 === 0) left.push(pin)
    else right.push(pin)
  }

  return {
    version: 1,
    generated_from: "component-evidence-v1",
    schPinArrangement: {
      leftSide: { direction: "top-to-bottom", pins: sortPins(left).map((pin) => pin.number) },
      rightSide: { direction: "top-to-bottom", pins: sortPins(right).map((pin) => pin.number) },
      topSide: { direction: "left-to-right", pins: sortPins(top).map((pin) => pin.number) },
      bottomSide: { direction: "left-to-right", pins: sortPins(bottom).map((pin) => pin.number) },
    },
  }
}
