import { mkdir, readdir, readFile, rm } from "node:fs/promises"
import { join, relative } from "node:path"
import type { AnyCircuitElement } from "circuit-json"
import { getAllCircuitErrors } from "../model-simulation-validator"
import { type StreamProcessInput, streamProcess, throwIfCancelled } from "./stream-job-process"

async function findCircuitJsonFile(directory: string): Promise<string | undefined> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const entry_path = join(directory, entry.name)
    if (entry.isDirectory()) {
      const nested_match = await findCircuitJsonFile(entry_path)
      if (nested_match) return nested_match
    } else if (entry.name.endsWith(".circuit.json") || entry.name === "circuit.json") {
      return entry_path
    }
  }
  return undefined
}

function isCircuitJson(parsed_json: unknown): parsed_json is AnyCircuitElement[] {
  return (
    Array.isArray(parsed_json) &&
    parsed_json.every(
      (element) => typeof element === "object" && element !== null && typeof element.type === "string",
    )
  )
}

export async function buildCircuitArtifact(input: {
  source_file: string
  output_stem: string
  job_dir: string
  tsci_bin: string
  signal: AbortSignal
  append: StreamProcessInput["on_chunk"]
  render_outputs?: boolean
  pcb_disabled?: boolean
  ignored_circuit_error_types?: string[]
  required_checks?: Array<"netlist" | "placement" | "routing-difficulty">
}): Promise<{ circuit_json: AnyCircuitElement[]; errors: string[] }> {
  const output_directory = join(input.job_dir, "dist", input.output_stem)
  const pcb_png_path = join(output_directory, "pcb.png")
  const schematic_svg_path = join(output_directory, "schematic.svg")
  const schematic_png_path = join(output_directory, "schematic.png")
  await rm(output_directory, { recursive: true, force: true })
  const check_errors: string[] = []
  for (const check of input.required_checks ?? []) {
    await input.append("system", `Running server-owned tsci ${check} check for ${input.source_file}…\n`)
    const check_exit_code = await streamProcess({
      command: [input.tsci_bin, "check", check, input.source_file],
      cwd: input.job_dir,
      signal: input.signal,
      on_chunk: input.append,
    })
    throwIfCancelled(input.signal)
    if (check_exit_code !== 0) {
      check_errors.push(`tsci check ${check} exited with code ${check_exit_code}`)
    }
  }
  const build_command = [
    input.tsci_bin,
    "build",
    input.source_file,
    "--ignore-errors",
    "--ignore-warnings",
    ...(input.pcb_disabled ? ["--disable-pcb"] : []),
    ...(input.render_outputs ? [...(input.pcb_disabled ? [] : ["--pcb-png"]), "--schematic-svgs"] : []),
  ]
  const build_exit_code = await streamProcess({
    command: build_command,
    cwd: input.job_dir,
    signal: input.signal,
    on_chunk: input.append,
  })
  throwIfCancelled(input.signal)
  const circuit_json_path = await findCircuitJsonFile(join(input.job_dir, "dist", input.output_stem))
  if (!circuit_json_path) {
    throw new Error(`tsci build exited with code ${build_exit_code} and produced no Circuit JSON`)
  }
  const parsed_json: unknown = JSON.parse(await readFile(circuit_json_path, "utf8"))
  if (!isCircuitJson(parsed_json)) throw new Error("tsci produced invalid Circuit JSON")
  const render_errors: string[] = []
  if (input.render_outputs) {
    await mkdir(output_directory, { recursive: true })
    if (await Bun.file(schematic_svg_path).exists()) {
      const render_exit_code = await streamProcess({
        command: [process.execPath, "render-svg-to-png.ts", relative(input.job_dir, schematic_svg_path)],
        cwd: input.job_dir,
        signal: input.signal,
        on_chunk: input.append,
      })
      if (render_exit_code !== 0) {
        render_errors.push(`schematic PNG renderer exited with code ${render_exit_code}`)
      }
    }
    if (!input.pcb_disabled && !(await Bun.file(pcb_png_path).exists())) {
      render_errors.push("final PCB PNG was not produced")
    }
    if (input.pcb_disabled && (await Bun.file(pcb_png_path).exists())) {
      render_errors.push("schematic-only build unexpectedly produced a PCB PNG")
    }
    if (!(await Bun.file(schematic_png_path).exists())) {
      render_errors.push("final schematic PNG was not produced")
    }
  }
  const circuit_errors = getAllCircuitErrors(parsed_json).filter(
    (error) => !input.ignored_circuit_error_types?.some((error_type) => error.startsWith(`${error_type}:`)),
  )
  const schematic_only_errors = input.pcb_disabled
    ? parsed_json.some((element) => element.type.startsWith("pcb_"))
      ? ["schematic-only build unexpectedly produced PCB Circuit JSON elements"]
      : []
    : []
  const errors = [
    ...check_errors,
    ...(build_exit_code === 0 ? [] : [`tsci build exited with code ${build_exit_code}`]),
    ...render_errors,
    ...schematic_only_errors,
    ...circuit_errors,
  ]
  const unique_errors = [...new Set(errors)]
  if (unique_errors.length > 0) {
    await input.append(
      "system",
      `Preview artifact contains ${unique_errors.length} blocking build error(s).\n`,
    )
  }
  return { circuit_json: parsed_json, errors: unique_errors }
}

export async function buildComponentValidationBoard(input: {
  job_dir: string
  tsci_bin: string
  signal: AbortSignal
  append: StreamProcessInput["on_chunk"]
}): Promise<{ circuit_json: AnyCircuitElement[]; errors: string[] }> {
  const source_file = "component-validation.circuit.tsx"
  const source_path = join(input.job_dir, source_file)
  await Bun.write(
    source_path,
    `import GeneratedComponent from "./index.circuit"

export default function ComponentValidationBoard() {
  return (
    <board>
      <GeneratedComponent />
    </board>
  )
}
`,
  )
  try {
    return await buildCircuitArtifact({
      source_file,
      output_stem: "component-validation",
      // This fixture intentionally instantiates an otherwise-unwired reusable
      // component. Floating required inputs are expected here; physical PCB
      // errors still fail the placement gate below.
      ignored_circuit_error_types: ["source_pin_must_be_connected_error"],
      ...input,
    })
  } finally {
    await rm(source_path, { force: true })
  }
}
