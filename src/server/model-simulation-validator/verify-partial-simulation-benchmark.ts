import { readFile } from "node:fs/promises"
import { join, relative } from "node:path"
import type { AnyCircuitElement } from "circuit-json"
import { SimulationBenchmarkVerification } from "./types"
import { assertSafeBenchmarkId } from "./parse-simulation-definition"
import { readSimulationDefinition } from "./simulation-definitions"
import { isCircuitJson } from "./get-circuit-build-diagnostics"
import { extractSimulationResultPoints, parseSimulationOutput } from "./extract-simulation-result-points"
import {
  assertCanonicalDutSimulation,
  assertNoSyntheticBenchmarkChannel,
} from "./assert-canonical-dut-simulation"
import {
  getModelSimulationSourceSignature,
  getValidationRoot,
  hashText,
  toCsv,
  writeArtifactCopies,
  writeTextAtomically,
} from "./simulation-validation-storage"

export async function verifyPartialSimulationBenchmark(input: {
  model_dir: string
  benchmark_id: string
  source_signature?: string
  circuit_json_paths: Array<{ path: string }>
}): Promise<SimulationBenchmarkVerification> {
  const generated_at = new Date().toISOString()
  assertSafeBenchmarkId(input.benchmark_id)
  const definition = await readSimulationDefinition(input.model_dir, input.benchmark_id)
  const source_path = join(input.model_dir, "benchmarks", `${input.benchmark_id}.circuit.tsx`)
  const supplied_paths = [...input.circuit_json_paths]
  if (supplied_paths.length === 0) throw new Error("partial validation has no simulator output")

  if (supplied_paths.length !== 1) {
    throw new Error("transient waveform validation requires exactly one simulator output")
  }
  const paths = supplied_paths
  const [source_text, model_source, ...circuit_texts] = await Promise.all([
    readFile(source_path, "utf8"),
    readFile(join(input.model_dir, "model.lib"), "utf8"),
    ...paths.map(({ path }) => readFile(path, "utf8")),
  ])
  const circuit_jsons: unknown[] = circuit_texts.map((text) => JSON.parse(text))
  if (circuit_jsons.some((json) => !isCircuitJson(json))) {
    throw new Error("partial simulation did not produce valid Circuit JSON")
  }
  const parsed = circuit_jsons.map((json) => parseSimulationOutput(json))
  const errors = [...new Set(parsed.flatMap(({ errors }) => errors))]
  if (errors.length > 0) throw new Error(errors.join("; "))
  assertNoSyntheticBenchmarkChannel(model_source)
  for (const circuit of circuit_jsons) {
    assertCanonicalDutSimulation({
      circuit_json: circuit as AnyCircuitElement[],
      model_source,
      probe_name: definition.probe_name,
      dut_spice_node: definition.dut_spice_node,
    })
  }

  const points = extractSimulationResultPoints(circuit_jsons[0], definition)
  const text = toCsv(points)
  const trusted_result_file = join(
    getValidationRoot(input.model_dir),
    "partial-results",
    `${input.benchmark_id}.csv`,
  )
  const diagnostic_result_file = join(input.model_dir, "results", "partial", `${input.benchmark_id}.csv`)
  await Promise.all([
    writeTextAtomically(trusted_result_file, text),
    writeTextAtomically(diagnostic_result_file, text),
  ])
  const artifact = await writeArtifactCopies({
    model_dir: input.model_dir,
    benchmark_id: input.benchmark_id,
    circuit_text: circuit_texts[0]!,
    source_text,
  })
  return {
    benchmark_id: input.benchmark_id,
    passed: false,
    status: "building",
    generated_at,
    ...artifact,
    source_signature:
      input.source_signature ??
      (await getModelSimulationSourceSignature(input.model_dir, input.benchmark_id)),
    partial_result_file: relative(getValidationRoot(input.model_dir), trusted_result_file),
    partial_sha256: hashText(text),
  }
}
