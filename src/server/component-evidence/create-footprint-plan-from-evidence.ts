import type { FootprintPlan } from "../job-artifact-validator"
import { ComponentEvidence } from "./types"

export function createFootprintPlanFromEvidence(evidence: ComponentEvidence): FootprintPlan {
  const references = new Map<string, { page: number; figure?: string }>()
  const footprint_sources = [
    ...evidence.footprint.drawing_orientation.sources,
    ...evidence.footprint.pads.flatMap((pad) => pad.sources),
  ]
  for (const source of footprint_sources) {
    const key = `${source.page}\u0000${source.figure ?? ""}`
    references.set(key, {
      page: source.page,
      ...(source.figure ? { figure: source.figure } : {}),
    })
  }
  const source_references = [...references.values()].sort(
    (left, right) => left.page - right.page || (left.figure ?? "").localeCompare(right.figure ?? ""),
  )
  return {
    version: 1,
    view: "pcb_top",
    source_references,
    pads: evidence.footprint.pads.map(({ sources: _sources, ...pad }) => pad),
  }
}
