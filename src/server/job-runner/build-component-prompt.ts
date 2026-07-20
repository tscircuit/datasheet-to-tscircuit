export function buildComponentPrompt(additional_instructions?: string): string {
  const user_context = additional_instructions?.trim()
    ? `\nAdditional context from the user:\n${additional_instructions.trim()}\n`
    : ""

  return `Generate the reusable tscircuit component from the server-approved evidence. Read AGENTS.md,
component-evidence.json, component-schematic-plan.json, and footprint-plan.json. Treat those files,
typical-application-plan.json,
and all existing files under visual-reference/ as read-only. Do not open, extract, render, search,
or otherwise access datasheet.pdf or datasheet.txt;
the approved JSON and reference PNG are the only allowed datasheet inputs in this phase.

Replace index.circuit.tsx with a production-quality, default-exported component. Implement the exact
part number, complete pin table, PCB-top pad geometry, and orientation from component-evidence.json.
Implement component-schematic-plan.json.schPinArrangement exactly; it is a server-derived,
deterministic layout contract based on independently agreed pin roles.
Do not substitute a generic library footprint unless its generated pad geometry exactly matches the
approved evidence. Keep schematic labels and aliases compact and readable. Do not use
placementDrcChecksDisabled, routingDisabled, --ignore-placement-drc, or similar suppression.

Run tsci build index.circuit.tsx --ignore-warnings --pcb-png --schematic-svgs, render the schematic
SVG, and inspect visual-reference/land-pattern.png, dist/index/pcb.png, and
dist/index/schematic.png with read after the final build. Correct defects and rebuild as needed.
Finally write component-visual-inspection.json exactly as
{ "version": 1, "status": "passed", "reference_image": "visual-reference/land-pattern.png",
  "pcb_image": "dist/index/pcb.png", "schematic_image": "dist/index/schematic.png" }.
If pixels are unavailable or the render conflicts with the evidence, record inconclusive and stop.
After the final build, run no shell command except the one schematic SVG-to-PNG render command. Do
not create typical-application.circuit.tsx.${user_context}`
}
