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
ordering_code when present (otherwise part_number), complete pin table, PCB-top pad geometry, and
orientation from component-evidence.json. Set chip pinAttributes from the approved electrical roles:
power_input requiresPower, power_output providesPower, and ground requiresGround. Do not assign any
of those attributes to pins with other roles. When electrical_attributes.open_drain is true, set
both canUseOpenDrain and isUsingOpenDrain; otherwise do not set either open-drain attribute.
Implement component-schematic-plan.json.schPinArrangement exactly; it is a server-derived,
deterministic layout contract based on independently agreed pin roles.
Do not substitute a generic library footprint unless its generated pad geometry exactly matches the
approved evidence. Keep schematic labels and aliases compact and readable. Do not use
placementDrcChecksDisabled, routingDisabled, --ignore-placement-drc, or similar suppression.

Before the final build, run \`tsci check netlist index.circuit.tsx\`,
\`tsci check placement index.circuit.tsx\`, and
\`tsci check routing-difficulty index.circuit.tsx\` as separate commands. Inspect and correct any
nonzero result; never chain checks together or dismiss a failed command as warnings. Then run the
final build below. The server independently rebuilds and validates the result.

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
