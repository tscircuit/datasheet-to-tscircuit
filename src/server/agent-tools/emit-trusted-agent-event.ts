import { AGENT_EVENT_PROTOCOL, type TrustedAgentEventPayload } from "../agent-event-protocol"

export interface TrustedAgentEventEmitter {
  sequence: number
}

export function emitTrustedAgentEvent(
  event: TrustedAgentEventPayload,
  emitter: TrustedAgentEventEmitter,
): void {
  emitter.sequence += 1
  process.stdout.write(
    `${JSON.stringify({ protocol: AGENT_EVENT_PROTOCOL, sequence: emitter.sequence, ...event })}\n`,
  )
}
