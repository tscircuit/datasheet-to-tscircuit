export function buildTypicalApplicationPrompt(additional_instructions?: string): string {
  const user_context = additional_instructions?.trim()
    ? `\nAdditional context from the user:\n${additional_instructions.trim()}\n`
    : ""

  return `Complete phase 2 of the datasheet conversion. The server has independently
built index.circuit.tsx and published it as ready; SPICE generation may now use it.

Read AGENTS.md and typical-application-plan.json first. Treat index.circuit.tsx,
component.circuit.tsx, component-evidence.json, component-schematic-plan.json,
footprint-plan.json, and
typical-application-plan.json as read-only. Do not open, extract, render, search, or otherwise access
datasheet.pdf or datasheet.txt; the approved JSON and reference PNG are the only allowed datasheet
inputs in this phase. Create
typical-application.circuit.tsx
as a default-exported tscircuit circuit that imports the generated component from
"./index.circuit" and implements the cited datasheet application faithfully. Use
the recorded external component values, connections, and operating context. Do
not replace the generated component with a generic chip or duplicate its
definition.

Never instantiate a standalone <netlabel> element. Net selectors such as "net.*" and "sel.net.*",
net-connected traces, trace schDisplayLabel props, and compiled schematic net-label records are
allowed. Arrange components compactly by signal flow, keep individual trace segments short, and
avoid large empty schematic regions.

Build the application with PCB and schematic visual outputs, render the schematic
  SVG to PNG, and inspect the locked reference,
PCB, and schematic PNGs with the built-in \`read\` tool. Compare the generated
schematic against the datasheet topology and values, fix visual or connectivity
defects, and do not suppress placement DRC, autorouting, or clearance failures with
placementDrcChecksDisabled, routingDisabled, --ignore-placement-drc, or similar
settings. Do not modify \`visual-reference/typical-application.png\`; it is the
server-locked reference selected during evidence extraction. After the final application build,
use \`read\` on that image, \`dist/typical-application/pcb.png\`, and
\`dist/typical-application/schematic.png\`, then write
\`application-visual-inspection.json\` with version 1, status passed, and those
paths in \`reference_image\`, \`pcb_image\`, and \`schematic_image\`. Never record
passed if any image was omitted or its pixels were unavailable; report
inconclusive and stop. Finish with a successful
\`tsci build typical-application.circuit.tsx\`. The importing application source,
inspected PCB and schematic renders, and successful build are the deliverables.
Write the inspection JSON with the built-in write tool. After the final build, the
only allowed shell command is the single render-svg-to-png command needed to create
the schematic PNG.${user_context}`
}
