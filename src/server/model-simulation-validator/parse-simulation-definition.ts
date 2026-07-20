import { SimulationExtractionDefinition } from "./types"

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function assertSafeBenchmarkId(benchmark_id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(benchmark_id)) {
    throw new Error(`Invalid benchmark id ${benchmark_id}`)
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function optionalFiniteNumber(input: { value: unknown; fallback: number; label: string }): number {
  const { value, fallback, label } = input
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`)
  return value
}

export function parseSimulationDefinition(value: unknown): SimulationExtractionDefinition {
  if (!isRecord(value)) {
    throw new Error(
      "benchmark has no server-verifiable simulation extraction; add simulation.kind and probe mapping",
    )
  }
  if (value.kind === "transient_voltage") {
    if (value.x_axis !== "time_ms") {
      throw new Error('simulation.x_axis must be "time_ms" for transient waveform benchmarks')
    }
    return {
      kind: "transient_voltage",
      x_axis: "time_ms",
      probe_name: requiredString(value.probe_name, "simulation.probe_name"),
      dut_spice_node: requiredString(value.dut_spice_node, "simulation.dut_spice_node"),
      scale: optionalFiniteNumber({ value: value.scale, fallback: 1, label: "simulation.scale" }),
      offset: optionalFiniteNumber({ value: value.offset, fallback: 0, label: "simulation.offset" }),
    }
  }
  throw new Error(
    'simulation.kind must be "transient_voltage"; only datasheet graphs whose x-axis is elapsed time are supported',
  )
}
