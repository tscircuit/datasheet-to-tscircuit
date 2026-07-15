import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, rename } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"
import ts from "typescript"
import { parseBenchmarkManifest, validateBenchmarkReferenceFiles } from "./model-scorer"
import { validateSimulationDefinitions } from "./model-simulation-validator"

interface LockedFile {
  file: string
  sha256: string
}

export interface BenchmarkLock {
  version: 1
  locked_at: string
  benchmark_ids: string[]
  files: LockedFile[]
}

interface BenchmarkRecord {
  id: string
  reference_file: string
  simulation?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

function getLockRoot(model_dir: string): string {
  return join(dirname(model_dir), ".model-benchmark-lock")
}

function getLockFile(model_dir: string): string {
  return join(getLockRoot(model_dir), "lock.json")
}

function resolveWorkspaceFile(model_dir: string, file: string): string {
  if (isAbsolute(file)) throw new Error(`Locked benchmark file must be relative: ${file}`)
  const resolved_root = resolve(model_dir)
  const resolved_file = resolve(resolved_root, file)
  if (!resolved_file.startsWith(`${resolved_root}${sep}`)) {
    throw new Error(`Locked benchmark file escapes the model workspace: ${file}`)
  }
  return resolved_file
}

function assertEvidenceFile(model_dir: string, file: string): void {
  const evidence_root = resolve(model_dir, "evidence")
  const resolved_file = resolve(model_dir, file)
  if (!resolved_file.startsWith(`${evidence_root}${sep}`)) {
    throw new Error(`Locked benchmark evidence must stay under evidence/: ${file}`)
  }
}

function parseBenchmarkRecords(value: unknown): BenchmarkRecord[] {
  return parseBenchmarkManifest(value).benchmarks.map((entry) => ({
    id: entry.id,
    reference_file: entry.reference_file,
    simulation: entry.simulation,
  }))
}

function assertSourceUsesSweepProps(source: string, benchmark: BenchmarkRecord): void {
  if (!isRecord(benchmark.simulation) || benchmark.simulation.kind !== "parameter_sweep") return
  if (!Array.isArray(benchmark.simulation.points) || benchmark.simulation.points.length < 2) return
  const prop_keys = new Set<string>()
  const point_x_values = new Set<number>()
  let expected_prop_signature: string | undefined
  for (const [index, point] of benchmark.simulation.points.entries()) {
    if (
      !isRecord(point) ||
      typeof point.x !== "number" ||
      !Number.isFinite(point.x) ||
      !isRecord(point.props) ||
      Object.keys(point.props).length === 0
    ) {
      throw new Error(`Benchmark ${benchmark.id} sweep point ${index + 1} has no injected props`)
    }
    if (point_x_values.has(point.x)) {
      throw new Error(`Benchmark ${benchmark.id} has duplicate sweep x=${point.x}`)
    }
    point_x_values.add(point.x)
    const point_prop_keys = Object.keys(point.props).sort()
    const prop_signature = JSON.stringify(point_prop_keys)
    if (expected_prop_signature !== undefined && prop_signature !== expected_prop_signature) {
      throw new Error(`Benchmark ${benchmark.id} sweep points must inject the same prop keys`)
    }
    expected_prop_signature = prop_signature
    for (const key of point_prop_keys) prop_keys.add(key)
  }
  for (const key of prop_keys) {
    if (!sourceConsumesInjectedProp(source, key)) {
      throw new Error(
        `Benchmark ${benchmark.id} does not use injected prop ${key} in a runtime expression; every sweep prop must affect the DUT harness`,
      )
    }
  }
}

function isRuntimeIdentifierRead(node: ts.Identifier): boolean {
  const parent = node.parent
  if (
    ((ts.isBindingElement(parent) ||
      ts.isParameter(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent)) &&
      parent.name === node) ||
    ((ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent)) &&
      parent.name === node) ||
    (ts.isJsxAttribute(parent) && parent.name === node) ||
    ts.isImportSpecifier(parent) ||
    ts.isExportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isInterfaceDeclaration(parent) ||
    ts.isTypeAliasDeclaration(parent) ||
    ts.isTypeParameterDeclaration(parent)
  ) {
    return false
  }
  for (let current: ts.Node | undefined = parent; current; current = current.parent) {
    if (ts.isTypeNode(current)) return false
    if (
      ts.isExpression(current) ||
      ts.isStatement(current) ||
      ts.isSourceFile(current) ||
      ts.isJsxExpression(current)
    ) {
      break
    }
  }
  return true
}

function functionConsumesInjectedProp(node: ts.FunctionLikeDeclaration, prop_name: string): boolean {
  const parameter = node.parameters[0]
  if (!parameter || !node.body) return false
  if (ts.isObjectBindingPattern(parameter.name)) {
    const binding = parameter.name.elements.find((element) => {
      const external_name = element.propertyName?.getText() ?? element.name.getText()
      return external_name === prop_name
    })
    if (!binding || !ts.isIdentifier(binding.name)) return false
    const local_name = binding.name.text
    let found = false
    const visit = (candidate: ts.Node) => {
      if (found) return
      if (
        candidate !== binding.name &&
        ts.isIdentifier(candidate) &&
        candidate.text === local_name &&
        isRuntimeIdentifierRead(candidate)
      ) {
        found = true
        return
      }
      ts.forEachChild(candidate, visit)
    }
    visit(node.body)
    return found
  }
  if (!ts.isIdentifier(parameter.name)) return false
  const parameter_name = parameter.name.text
  let found = false
  const visit = (candidate: ts.Node) => {
    if (found) return
    if (
      ts.isPropertyAccessExpression(candidate) &&
      ts.isIdentifier(candidate.expression) &&
      candidate.expression.text === parameter_name &&
      candidate.name.text === prop_name
    ) {
      found = true
      return
    }
    if (
      ts.isElementAccessExpression(candidate) &&
      ts.isIdentifier(candidate.expression) &&
      candidate.expression.text === parameter_name &&
      ts.isStringLiteral(candidate.argumentExpression) &&
      candidate.argumentExpression.text === prop_name
    ) {
      found = true
      return
    }
    ts.forEachChild(candidate, visit)
  }
  visit(node.body)
  return found
}

function sourceConsumesInjectedProp(source: string, identifier: string): boolean {
  const source_file = ts.createSourceFile(
    "benchmark.circuit.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  let found = false
  const visit = (node: ts.Node) => {
    if (found) return
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node)) &&
      functionConsumesInjectedProp(node, identifier)
    ) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source_file)
  return found
}

function assertSourceParses(source: string, benchmark_id: string): void {
  const source_file = ts.createSourceFile(
    `${benchmark_id}.circuit.tsx`,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  ) as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }
  const diagnostic = source_file.parseDiagnostics?.[0]
  if (!diagnostic) return
  throw new Error(
    `Benchmark ${benchmark_id} has invalid TSX: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
  )
}

function assertBenchmarkSourceContract(source: string, benchmark: BenchmarkRecord): void {
  assertSourceParses(source, benchmark.id)
  if (
    !isRecord(benchmark.simulation) ||
    typeof benchmark.simulation.probe_name !== "string" ||
    !benchmark.simulation.probe_name.trim() ||
    typeof benchmark.simulation.dut_spice_node !== "string" ||
    !benchmark.simulation.dut_spice_node.trim()
  ) {
    throw new Error(
      `Benchmark ${benchmark.id} must declare simulation.probe_name and simulation.dut_spice_node`,
    )
  }
  if (!/component-with-model(?:\.circuit)?["']/.test(source)) {
    throw new Error(`Benchmark ${benchmark.id} must import component-with-model.circuit`)
  }
  if (!/<[A-Z][A-Za-z0-9_$]*\b[^>]*\bname=["']DUT["']/.test(source)) {
    throw new Error(`Benchmark ${benchmark.id} must instantiate exactly one model component named DUT`)
  }
  if ((source.match(/\bname=["']DUT["']/g) ?? []).length !== 1) {
    throw new Error(`Benchmark ${benchmark.id} must instantiate exactly one component named DUT`)
  }
  if (!/<analogsimulation\b[^>]*\bspiceEngine=["']ngspice["']/.test(source)) {
    throw new Error(`Benchmark ${benchmark.id} must run an ngspice analogsimulation`)
  }
  const probe_name = isRecord(benchmark.simulation) ? benchmark.simulation.probe_name : undefined
  if (typeof probe_name === "string") {
    const escaped_probe = probe_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    if (!new RegExp(`<voltageprobe\\b[^>]*\\bname=["']${escaped_probe}["']`).test(source)) {
      throw new Error(`Benchmark ${benchmark.id} must define voltage probe ${probe_name}`)
    }
  }
  if (/\b(selector|telemetry|benchmark[_ -]?code|metric[_ -]?channel)\b/i.test(source)) {
    throw new Error(`Benchmark ${benchmark.id} contains a synthetic benchmark backchannel`)
  }
  assertSourceUsesSweepProps(source, benchmark)
}

async function readCurrentLock(model_dir: string): Promise<{
  benchmark_ids: string[]
  files: Array<LockedFile & { text: string }>
}> {
  const manifest_text = await readFile(join(model_dir, "benchmarks.json"), "utf8")
  const manifest_value = JSON.parse(manifest_text) as unknown
  const manifest = parseBenchmarkManifest(manifest_value)
  const records = parseBenchmarkRecords(manifest_value)
  for (const record of records) assertEvidenceFile(model_dir, record.reference_file)
  await validateBenchmarkReferenceFiles(model_dir, manifest)
  await validateSimulationDefinitions(
    model_dir,
    records.map((record) => record.id),
  )
  const benchmark_entries = await readdir(join(model_dir, "benchmarks")).catch(() => [])
  const benchmark_files = benchmark_entries.filter((entry) => entry.endsWith(".circuit.tsx")).sort()
  const expected_files = records.map((record) => `${record.id}.circuit.tsx`).sort()
  if (JSON.stringify(benchmark_files) !== JSON.stringify(expected_files)) {
    throw new Error("benchmarks.json and benchmarks/*.circuit.tsx must contain the same locked benchmark ids")
  }

  const paths = [
    "benchmarks.json",
    ...records.map((record) => join("benchmarks", `${record.id}.circuit.tsx`)),
    ...records.map((record) => record.reference_file),
  ]
  const unique_paths = [...new Set(paths)]
  const files = await Promise.all(
    unique_paths.map(async (file) => {
      const text = await readFile(resolveWorkspaceFile(model_dir, file), "utf8")
      return { file, text, sha256: hashText(text) }
    }),
  )
  for (const record of records) {
    const source = files.find((file) => file.file === join("benchmarks", `${record.id}.circuit.tsx`))?.text
    if (!source) throw new Error(`Benchmark ${record.id} source is missing`)
    assertBenchmarkSourceContract(source, record)
  }
  return { benchmark_ids: records.map((record) => record.id).sort(), files }
}

async function writeTextAtomically(file_path: string, text: string): Promise<void> {
  await mkdir(dirname(file_path), { recursive: true })
  const temporary_path = `${file_path}.${crypto.randomUUID()}.tmp`
  await Bun.write(temporary_path, text)
  await rename(temporary_path, file_path)
}

function parseLock(value: unknown): BenchmarkLock {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.locked_at !== "string" ||
    !Array.isArray(value.benchmark_ids) ||
    !value.benchmark_ids.every((id) => typeof id === "string") ||
    !Array.isArray(value.files) ||
    !value.files.every(
      (file) => isRecord(file) && typeof file.file === "string" && typeof file.sha256 === "string",
    )
  ) {
    throw new Error("The server-owned benchmark lock is invalid")
  }
  return value as unknown as BenchmarkLock
}

export async function hasBenchmarkManifest(model_dir: string): Promise<boolean> {
  return Bun.file(join(model_dir, "benchmarks.json")).exists()
}

export async function hasBenchmarkLock(model_dir: string): Promise<boolean> {
  return Bun.file(getLockFile(model_dir)).exists()
}

export async function createOrVerifyBenchmarkLock(model_dir: string): Promise<BenchmarkLock> {
  const current = await readCurrentLock(model_dir)
  const lock_path = getLockFile(model_dir)
  const existing_value = await readFile(lock_path, "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => undefined)
  if (existing_value !== undefined) {
    const existing = parseLock(existing_value)
    const expected = existing.files.map(({ file, sha256 }) => ({ file, sha256 }))
    const actual = current.files.map(({ file, sha256 }) => ({ file, sha256 }))
    if (
      JSON.stringify(existing.benchmark_ids) !== JSON.stringify(current.benchmark_ids) ||
      JSON.stringify(expected) !== JSON.stringify(actual)
    ) {
      throw new Error(
        "The locked benchmark suite or evidence changed after refinement began; restore the original files instead of weakening validation",
      )
    }
    return existing
  }

  const locked_at = new Date().toISOString()
  const lock: BenchmarkLock = {
    version: 1,
    locked_at,
    benchmark_ids: current.benchmark_ids,
    files: current.files.map(({ file, sha256 }) => ({ file, sha256 })),
  }
  const snapshot_root = join(getLockRoot(model_dir), "snapshot")
  await Promise.all(
    current.files.map(({ file, text }) => writeTextAtomically(join(snapshot_root, file), text)),
  )
  await writeTextAtomically(lock_path, `${JSON.stringify(lock, null, 2)}\n`)
  return lock
}

export async function verifyBenchmarkLock(
  model_dir: string,
  expected_lock?: BenchmarkLock,
): Promise<BenchmarkLock> {
  const value: unknown = JSON.parse(await readFile(getLockFile(model_dir), "utf8"))
  const lock = parseLock(value)
  if (
    expected_lock &&
    (expected_lock.locked_at !== lock.locked_at ||
      JSON.stringify(expected_lock.benchmark_ids) !== JSON.stringify(lock.benchmark_ids) ||
      JSON.stringify(expected_lock.files) !== JSON.stringify(lock.files))
  ) {
    throw new Error("The server-owned benchmark lock changed while the model workflow was running")
  }
  const current = await readCurrentLock(model_dir)
  const trusted_lock = expected_lock ?? lock
  if (
    JSON.stringify(trusted_lock.benchmark_ids) !== JSON.stringify(current.benchmark_ids) ||
    JSON.stringify(trusted_lock.files.map(({ file, sha256 }) => ({ file, sha256 }))) !==
      JSON.stringify(current.files.map(({ file, sha256 }) => ({ file, sha256 })))
  ) {
    throw new Error("The server-owned benchmark lock no longer matches the model workspace")
  }
  return trusted_lock
}
