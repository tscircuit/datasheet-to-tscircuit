export type { BenchmarkLock } from "./types"
export {
  hasBenchmarkManifest,
  hasBenchmarkLock,
  validateBenchmarkSuiteForLock,
  createOrVerifyBenchmarkLock,
  replaceBenchmarkLockAfterCircuitRepair,
  verifyBenchmarkLock,
} from "./benchmark-lock"
