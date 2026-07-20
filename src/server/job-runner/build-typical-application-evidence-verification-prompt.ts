import { buildAgentPrompt } from "./build-agent-prompt"

export function buildTypicalApplicationEvidenceVerificationPrompt(
  additional_instructions?: string,
  retry_feedback?: string,
): string {
  return `Independently extract the evidence. You have no earlier plan and must not infer what another
agent selected. Apply the same user-supplied part and package constraints, but perform a fresh
datasheet extraction. Perform a dedicated wire-tracing pass on the typical-application image:
inspect every crossing at high zoom, distinguish junction dots from bridge arcs, and trace both
ends of each pull-up resistor to their labeled rail before writing any connections.\n\n${buildAgentPrompt(additional_instructions, retry_feedback)}`
}
