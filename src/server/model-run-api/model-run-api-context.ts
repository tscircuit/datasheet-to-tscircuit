import { runModel, type ModelRunnerContext } from "../model-runner"

export interface ModelRunApiContext extends ModelRunnerContext {
  run_model?: typeof runModel
  model_base_effort_ms?: number
}
