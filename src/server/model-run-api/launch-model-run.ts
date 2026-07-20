import { join } from "node:path"
import { runModel } from "../model-runner"
import { ModelRunApiContext } from "./model-run-api-context"
import { createModelRun } from "./create-model-run"
import { getModelRun } from "./get-model-run"

export async function launchModelRun(
  input: { job_id: string; job_dir: string; effort_multiplier: number },
  context: ModelRunApiContext,
) {
  const model_run_id = crypto.randomUUID()
  const configured_base_effort_ms =
    context.model_base_effort_ms ?? Number(process.env.MODEL_BASE_EFFORT_MS ?? 30 * 60 * 1000)
  const base_effort_ms =
    Number.isFinite(configured_base_effort_ms) && configured_base_effort_ms > 0
      ? configured_base_effort_ms
      : 30 * 60 * 1000
  context.model_run_store.createModelRun({
    model_run_id,
    job_id: input.job_id,
    model_dir: join(input.job_dir, "spice"),
    effort_multiplier: input.effort_multiplier,
    base_effort_ms,
  })
  await context.model_run_store.appendLog(model_run_id, {
    stream: "system",
    message: `Created a ${input.effort_multiplier}× SPICE behavioral-model run validated with ngspice. Evidence setup, component waiting, and benchmark locking are untimed; effort applies only to refinement.\n`,
  })
  const runner = context.run_model ?? runModel
  void runner({ model_run_id }, context)
  return context.model_run_store.getModelRun(model_run_id)!
}
