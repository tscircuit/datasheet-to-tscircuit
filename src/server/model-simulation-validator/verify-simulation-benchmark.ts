import { mkdir, readFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import type { AnyCircuitElement } from "circuit-json"
import { SimulationBenchmarkVerification } from "./types"
import { assertSafeBenchmarkId } from "./parse-simulation-definition"
import { readSimulationDefinition } from "./simulation-definitions"
import { isCircuitJson } from "./get-circuit-build-diagnostics"
import {
  getModelSimulationSourceSignature,
  getValidationRoot,
  getVerifiedResultsDirectory,
  hashText,
  toCsv,
  writeArtifactCopies,
  writeTextAtomically,
} from "./simulation-validation-storage"
import { extractSimulationResultPoints, parseSimulationOutput } from "./extract-simulation-result-points"
import {
  assertCanonicalDutSimulation,
  assertNoSyntheticBenchmarkChannel,
} from "./assert-canonical-dut-simulation"

export async function verifySimulationBenchmark(input: {
  model_dir: string
  benchmark_id: string
  source_signature?: string
  circuit_json_paths?: Array<{ path: string }>
}): Promise<SimulationBenchmarkVerification> {
  const generated_at = new Date().toISOString()
  let artifact: Partial<SimulationBenchmarkVerification> = {}
  try {
    assertSafeBenchmarkId(input.benchmark_id)
    const job_dir = dirname(input.model_dir)
    const source_path = join(input.model_dir, "benchmarks", `${input.benchmark_id}.circuit.tsx`)
    const circuit_json_path = join(job_dir, "dist", "spice", "benchmarks", input.benchmark_id, "circuit.json")
    const definition = await readSimulationDefinition(input.model_dir, input.benchmark_id)
    const supplied_paths: Array<{ path: string }> = input.circuit_json_paths?.length
      ? input.circuit_json_paths
      : [{ path: circuit_json_path }]
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
    if (circuit_jsons.some((json) => !isCircuitJson(json)))
      throw new Error("simulation did not produce valid Circuit JSON")
    const circuit_text = circuit_texts[0]!
    const circuit_json = circuit_jsons[0] as AnyCircuitElement[]
    artifact = {
      ...(await writeArtifactCopies({
        model_dir: input.model_dir,
        benchmark_id: input.benchmark_id,
        circuit_text,
        source_text,
      })),
      source_signature:
        input.source_signature ??
        (await getModelSimulationSourceSignature(input.model_dir, input.benchmark_id)),
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

    const points = extractSimulationResultPoints(circuit_json, definition)
    const text = toCsv(points)
    const trusted_result_file = join(
      getVerifiedResultsDirectory(input.model_dir),
      `${input.benchmark_id}.csv`,
    )
    const diagnostic_result_file = join(input.model_dir, "results", "verified", `${input.benchmark_id}.csv`)
    const diagnostic_artifact_file = join(
      input.model_dir,
      "validation-artifacts",
      input.benchmark_id,
      "result.csv",
    )
    await Promise.all([
      mkdir(dirname(trusted_result_file), { recursive: true }),
      mkdir(dirname(diagnostic_result_file), { recursive: true }),
    ])
    await Promise.all([
      writeTextAtomically(trusted_result_file, text),
      writeTextAtomically(diagnostic_result_file, text),
      writeTextAtomically(diagnostic_artifact_file, text),
    ])
    return {
      benchmark_id: input.benchmark_id,
      passed: true,
      status: "passed",
      generated_at,
      ...artifact,
      verified_result_file: relative(getValidationRoot(input.model_dir), trusted_result_file),
      sha256: hashText(text),
    }
  } catch (error) {
    return {
      benchmark_id: input.benchmark_id,
      passed: false,
      status: "failed",
      generated_at,
      ...artifact,
      error_message: error instanceof Error ? error.message : String(error),
    }
  }
}
