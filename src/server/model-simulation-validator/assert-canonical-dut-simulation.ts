import { join } from "node:path"
import type { AnyCircuitElement } from "circuit-json"
import { isRecord } from "./parse-simulation-definition"

function normalizeModelSource(source: string): string {
  return source.replace(/\r\n?/g, "\n").trim()
}

function parseSubcircuits(model_source: string): Array<{ name: string; pins: string[] }> {
  const lines = model_source.replace(/\r\n?/g, "\n").split("\n")
  const subcircuits: Array<{ name: string; pins: string[] }> = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]!.match(/^\s*\.\s*subckt\s+(\S+)(?:\s+(.*))?$/i)
    if (!match) continue
    const tokens = (match[2] ?? "").trim().split(/\s+/).filter(Boolean)
    while (index + 1 < lines.length) {
      const continuation = lines[index + 1]!.match(/^\s*\+\s*(.*)$/)
      if (!continuation) break
      index += 1
      tokens.push(...continuation[1]!.trim().split(/\s+/).filter(Boolean))
    }
    const parameter_index = tokens.findIndex(
      (token) => /^params?:/i.test(token) || token.includes("=") || /^[;$]/.test(token),
    )
    subcircuits.push({
      name: match[1]!,
      pins: parameter_index < 0 ? tokens : tokens.slice(0, parameter_index),
    })
  }
  return subcircuits
}

export function assertNoSyntheticBenchmarkChannel(model_source: string): void {
  const comments = model_source
    .split(/\r?\n/)
    .filter((line) => /^\s*[*;$]/.test(line))
    .join("\n")
  if (/\b(selector|telemetry|benchmark[_ -]?code|metric[_ -]?channel|selected metric)\b/i.test(comments)) {
    throw new Error("model.lib declares a synthetic benchmark selector or telemetry channel")
  }
}

class Connectivity {
  private parent = new Map<string, string>()

  private root(value: string): string {
    const parent = this.parent.get(value)
    if (!parent) {
      this.parent.set(value, value)
      return value
    }
    if (parent === value) return value
    const root = this.root(parent)
    this.parent.set(value, root)
    return root
  }

  connect(values: string[]): void {
    const [first, ...rest] = values
    if (!first) return
    const first_root = this.root(first)
    for (const value of rest) this.parent.set(this.root(value), first_root)
  }

  connected(first: string, second: string): boolean {
    return this.root(first) === this.root(second)
  }
}

function portKey(port_id: string): string {
  return `port:${port_id}`
}

function netKey(net_id: string): string {
  return `net:${net_id}`
}

export function assertCanonicalDutSimulation(input: {
  circuit_json: AnyCircuitElement[]
  model_source: string
  probe_name: string
  dut_spice_node: string
}): void {
  const { circuit_json, model_source, probe_name, dut_spice_node } = input
  const records = circuit_json.map((element): Record<string, unknown> => ({ ...element })).filter(isRecord)
  const dut_components = records.filter(
    (element) => element.type === "source_component" && element.name === "DUT",
  )
  if (dut_components.length !== 1 || typeof dut_components[0]?.source_component_id !== "string") {
    throw new Error("simulation must contain exactly one source component named DUT")
  }
  const dut_id = dut_components[0].source_component_id
  const dut_ports = records.filter(
    (element) =>
      element.type === "source_port" &&
      element.source_component_id === dut_id &&
      typeof element.source_port_id === "string",
  )
  if (dut_ports.length === 0) throw new Error("DUT has no source ports in simulation output")

  const spice_models = records.filter(
    (element) => element.type === "simulation_spice_subcircuit" && element.source_component_id === dut_id,
  )
  if (spice_models.length !== 1 || !isRecord(spice_models[0])) {
    throw new Error("DUT must have exactly one canonical simulation_spice_subcircuit")
  }
  const spice_model = spice_models[0]
  if (
    typeof spice_model.subcircuit_source !== "string" ||
    normalizeModelSource(spice_model.subcircuit_source) !== normalizeModelSource(model_source)
  ) {
    throw new Error("DUT simulation does not use the canonical model.lib source")
  }
  if (!isRecord(spice_model.spice_pin_to_source_port_map)) {
    throw new Error("DUT SPICE pin mapping is missing")
  }
  const dut_port_ids = new Set(dut_ports.map((port) => port.source_port_id as string))
  const mapped_spice_pins = Object.keys(spice_model.spice_pin_to_source_port_map)
  const mapped_port_ids = Object.values(spice_model.spice_pin_to_source_port_map)
  if (
    mapped_port_ids.length === 0 ||
    new Set(mapped_port_ids).size !== mapped_port_ids.length ||
    mapped_port_ids.some((port_id) => typeof port_id !== "string" || !dut_port_ids.has(port_id))
  ) {
    throw new Error("DUT SPICE pin mapping does not resolve exclusively to DUT ports")
  }
  const first_subcircuit = parseSubcircuits(model_source)[0]
  const sorted_mapping = [...mapped_spice_pins].sort()
  if (
    !first_subcircuit ||
    first_subcircuit.pins.length === 0 ||
    JSON.stringify([...first_subcircuit.pins].sort()) !== JSON.stringify(sorted_mapping)
  ) {
    throw new Error(
      "DUT SPICE pin mapping must cover every .SUBCKT pin in the first declaration exactly once with matching case",
    )
  }

  const probes = records.filter(
    (element) => element.type === "simulation_voltage_probe" && element.name === probe_name,
  )
  if (probes.length !== 1 || !isRecord(probes[0])) {
    throw new Error(`simulation must contain exactly one voltage probe named ${probe_name}`)
  }
  const probe = probes[0]
  const signal_key =
    typeof probe.signal_input_source_port_id === "string"
      ? portKey(probe.signal_input_source_port_id)
      : typeof probe.signal_input_source_net_id === "string"
        ? netKey(probe.signal_input_source_net_id)
        : undefined
  if (!signal_key) throw new Error(`${probe_name} has no signal input connectivity`)

  const connectivity = new Connectivity()
  for (const trace of records) {
    if (trace.type !== "source_trace") continue
    const connected = [
      ...(Array.isArray(trace.connected_source_port_ids)
        ? trace.connected_source_port_ids.filter((id): id is string => typeof id === "string").map(portKey)
        : []),
      ...(Array.isArray(trace.connected_source_net_ids)
        ? trace.connected_source_net_ids.filter((id): id is string => typeof id === "string").map(netKey)
        : []),
    ]
    connectivity.connect(connected)
  }
  const expected_mapping = Object.entries(spice_model.spice_pin_to_source_port_map).find(
    ([spice_pin]) => spice_pin.toLowerCase() === dut_spice_node.toLowerCase(),
  )
  const expected_port_id = expected_mapping?.[1]
  if (typeof expected_port_id !== "string") {
    throw new Error(`simulation.dut_spice_node ${dut_spice_node} is not mapped by the canonical DUT`)
  }
  if (!connectivity.connected(signal_key, portKey(expected_port_id))) {
    throw new Error(
      `${probe_name} must measure canonical DUT SPICE node ${dut_spice_node}, not another DUT pin`,
    )
  }

  const voltage_source_endpoint_keys = records
    .filter((element) => element.type === "simulation_voltage_source")
    .flatMap((source) => {
      const keys: string[] = []
      for (const field of [
        "positive_source_port_id",
        "negative_source_port_id",
        "terminal1_source_port_id",
        "terminal2_source_port_id",
      ] as const) {
        if (typeof source[field] === "string") keys.push(portKey(source[field]))
      }
      for (const field of [
        "positive_source_net_id",
        "negative_source_net_id",
        "terminal1_source_net_id",
        "terminal2_source_net_id",
      ] as const) {
        if (typeof source[field] === "string") keys.push(netKey(source[field]))
      }
      return keys
    })
  if (voltage_source_endpoint_keys.some((endpoint) => connectivity.connected(signal_key, endpoint))) {
    throw new Error(`${probe_name} is tied directly to an independent voltage source`)
  }
}
