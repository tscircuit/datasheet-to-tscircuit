import { copyFile, readFile } from "node:fs/promises"
import { join } from "node:path"
import type { ModelManifest } from "@/shared/job-types"
import type { JobStore } from "../job-store"

export function isCircuitJson(value: unknown): value is import("circuit-json").AnyCircuitElement[] {
  return (
    Array.isArray(value) &&
    value.every(
      (element) => typeof element === "object" && element !== null && typeof element.type === "string",
    )
  )
}

export async function attachModelToGeneratedComponent(input: {
  job_id: string
  job_dir: string
  model_dir: string
  job_store: JobStore
}): Promise<void> {
  const integrated_component = join(input.model_dir, "component-with-model.circuit.tsx")
  const original_component = join(input.model_dir, "component.circuit.tsx")
  await Promise.all([
    copyFile(integrated_component, join(input.job_dir, "index.circuit.tsx")),
    copyFile(original_component, join(input.job_dir, "component.circuit.tsx")),
    copyFile(join(input.model_dir, "model.lib"), join(input.job_dir, "model.lib")),
  ])
  const [component_code, circuit_json_value] = await Promise.all([
    readFile(integrated_component, "utf8"),
    readFile(join(input.job_dir, "dist", "spice", "component-with-model", "circuit.json"), "utf8")
      .then((text) => JSON.parse(text))
      .catch(() => undefined),
  ])
  input.job_store.updateJob(input.job_id, {
    component_code,
    ...(isCircuitJson(circuit_json_value) ? { circuit_json: circuit_json_value } : {}),
  })
}

export async function writeServerIntegratedComponent(input: {
  model_dir: string
  manifest: ModelManifest
  model_source: string
}): Promise<void> {
  const spice_pin_mapping = Object.fromEntries(
    input.manifest.pins.map((pin) => [pin.spice_node, pin.component_pin]),
  )
  await Bun.write(
    join(input.model_dir, "component-with-model.circuit.tsx"),
    `import type { ComponentProps } from "react"
import Component from "./component.circuit"

const modelSource = ${JSON.stringify(input.model_source)}
const ModelComponent = Component as import("react").ComponentType<
  ComponentWithModelProps & { spiceModel: import("react").ReactNode }
>

export type ComponentWithModelProps = ComponentProps<typeof Component>

export default function ComponentWithModel(props: ComponentWithModelProps) {
  return (
    <ModelComponent
      {...props}
      spiceModel={
        <spicemodel
          source={modelSource}
          spicePinMapping={${JSON.stringify(spice_pin_mapping, null, 2)}}
        />
      }
    />
  )
}
`,
  )
}

function normalizeModelSource(source: string): string {
  return source.replace(/\r\n?/g, "\n").trim()
}

export function assertIntegratedCircuitUsesCanonicalModel(value: unknown, model_source: string): void {
  if (!isCircuitJson(value)) throw new Error("The integrated component did not produce valid Circuit JSON")
  const spice_models = value.filter((element) => element.type === "simulation_spice_subcircuit")
  if (
    spice_models.length !== 1 ||
    !("subcircuit_source" in spice_models[0]!) ||
    typeof spice_models[0]!.subcircuit_source !== "string" ||
    normalizeModelSource(spice_models[0]!.subcircuit_source) !== normalizeModelSource(model_source)
  ) {
    throw new Error("The integrated component does not contain exactly one canonical model.lib subcircuit")
  }
}
