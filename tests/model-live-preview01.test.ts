import { expect, test } from "bun:test"
import type { ModelCircuitPreview } from "@/shared/job-types"
import { getComparisonScaleDisparity, getRunframeCircuitJson } from "@/web/components/model-live-preview"

const previous_circuit_json: NonNullable<ModelCircuitPreview["circuit_json"]> = []
const live_circuit_json: NonNullable<ModelCircuitPreview["circuit_json"]> = []

test("the code tab keeps a stable Circuit JSON reference while live previews update", () => {
  expect(
    getRunframeCircuitJson({
      active_tab: "code",
      live_circuit_json,
      code_tab_circuit_json: previous_circuit_json,
    }),
  ).toBe(previous_circuit_json)
  expect(
    getRunframeCircuitJson({
      active_tab: "analog_simulation",
      live_circuit_json,
      code_tab_circuit_json: previous_circuit_json,
    }),
  ).toBe(live_circuit_json)
  expect(
    getRunframeCircuitJson({
      active_tab: "schematic",
      live_circuit_json,
      code_tab_circuit_json: previous_circuit_json,
    }),
  ).toBe(live_circuit_json)
})

test("the code tab uses live Circuit JSON until it has captured a snapshot", () => {
  expect(
    getRunframeCircuitJson({
      active_tab: "code",
      live_circuit_json: live_circuit_json as ModelCircuitPreview["circuit_json"],
      code_tab_circuit_json: undefined,
    }),
  ).toBe(live_circuit_json)
})

test("comparison graphs identify independently auto-scaled waveforms", () => {
  expect(
    getComparisonScaleDisparity(
      [
        { x: 0, y: 0 },
        { x: 1, y: 3.3 },
      ],
      [
        { x: 0, y: 7.3e-13 },
        { x: 1, y: 2.15e-10 },
      ],
    ),
  ).toEqual({ reference_min: 0, reference_max: 3.3, result_min: 7.3e-13, result_max: 2.15e-10 })
  expect(
    getComparisonScaleDisparity(
      [
        { x: 0, y: 0 },
        { x: 1, y: 3.3 },
      ],
      [
        { x: 0, y: 0.1 },
        { x: 1, y: 3.2 },
      ],
    ),
  ).toBeUndefined()
})
