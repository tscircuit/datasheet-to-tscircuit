import { join } from "node:path"
import { TSCIRCUIT_RUNTIME_CONFIG } from "./tscircuit-runtime-config"

export async function ensureJobTscircuitRuntimeConfig(job_dir: string): Promise<void> {
  await Bun.write(join(job_dir, "tscircuit.config.ts"), TSCIRCUIT_RUNTIME_CONFIG)
}
