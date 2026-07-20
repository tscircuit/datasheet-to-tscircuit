export type { BenchmarkLock } from "./model-benchmark-lock/types"
export {
  hasBenchmarkManifest,
  hasBenchmarkLock,
  validateBenchmarkSuiteForLock,
  createOrVerifyBenchmarkLock,
  replaceBenchmarkLockAfterCircuitRepair,
  verifyBenchmarkLock,
} from "./model-benchmark-lock/benchmark-lock"
