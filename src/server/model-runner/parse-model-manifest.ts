import type { ModelManifest } from "@/shared/job-types"

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseModelManifest(value: unknown): ModelManifest {
  if (!isRecord(value) || value.version !== 1) throw new Error("model-manifest.json must be version 1")
  const required_strings = [
    "part_number",
    "entry_name",
    "model_file",
    "revision",
    "simulator",
    "generated_at",
  ] as const
  for (const key of required_strings) {
    if (typeof value[key] !== "string" || value[key].trim() === "") {
      throw new Error(`model-manifest.json has no ${key}`)
    }
  }
  if (value.model_file !== "model.lib") throw new Error('model-manifest.json model_file must be "model.lib"')
  if (value.dialect !== "pspice" && value.dialect !== "ngspice" && value.dialect !== "portable") {
    throw new Error("model-manifest.json has an unsupported dialect")
  }
  if (value.simulator !== "ngspice") {
    throw new Error('model-manifest.json simulator must be "ngspice" for this validation workflow')
  }
  if (!Array.isArray(value.pins) || value.pins.length === 0) {
    throw new Error("model-manifest.json must contain an explicit pin mapping")
  }
  const pins = value.pins.map((pin, index) => {
    if (
      !isRecord(pin) ||
      typeof pin.component_pin !== "string" ||
      !pin.component_pin ||
      typeof pin.spice_node !== "string" ||
      !pin.spice_node
    ) {
      throw new Error(`model-manifest.json pin ${index + 1} is invalid`)
    }
    return { component_pin: pin.component_pin, spice_node: pin.spice_node }
  })

  return {
    version: 1,
    part_number: value.part_number as string,
    dialect: value.dialect,
    entry_name: value.entry_name as string,
    model_file: "model.lib",
    revision: value.revision as string,
    simulator: "ngspice",
    generated_at: value.generated_at as string,
    pins,
  }
}

function parseSubcircuitHeaders(model_source: string): Array<{ name: string; pins: string[] }> {
  const lines = model_source.replace(/\r\n?/g, "\n").split("\n")
  const headers: Array<{ name: string; pins: string[] }> = []
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
    const pins = parameter_index < 0 ? tokens : tokens.slice(0, parameter_index)
    headers.push({ name: match[1]!, pins })
  }
  return headers
}

export function validateManifestAgainstModel(manifest: ModelManifest, model_source: string): void {
  const headers = parseSubcircuitHeaders(model_source)
  const subcircuit = headers[0]
  if (!subcircuit || subcircuit.name.toLowerCase() !== manifest.entry_name.toLowerCase()) {
    throw new Error(
      `model-manifest.json entry_name ${manifest.entry_name} must match the first model.lib .SUBCKT`,
    )
  }
  if (subcircuit.pins.length === 0) throw new Error("model.lib .SUBCKT declaration has no pins")
  const manifest_nodes = manifest.pins.map((pin) => pin.spice_node)
  const component_pins = manifest.pins.map((pin) => pin.component_pin)
  if (
    new Set(manifest_nodes).size !== manifest_nodes.length ||
    new Set(component_pins).size !== component_pins.length
  ) {
    throw new Error("model-manifest.json pin mappings must be one-to-one")
  }
  if (JSON.stringify([...subcircuit.pins].sort()) !== JSON.stringify([...manifest_nodes].sort())) {
    throw new Error("model-manifest.json must map every first-.SUBCKT pin exactly once with matching case")
  }
}
