import type { ExpectedFootprintPad } from "../job-artifact-validator"

export type EvidenceConfidence = "high" | "medium" | "low"

export type EvidenceMethod = "pdf_text" | "pdf_visual" | "calculated" | "package_standard"

export type DrawingOrientation = "pcb_top" | "package_top" | "package_bottom" | "side" | "unknown"

export type SchematicPinRole =
  | "power_input"
  | "power_output"
  | "ground"
  | "input"
  | "output"
  | "bidirectional"
  | "passive"
  | "no_connect"
  | "other"

export interface EvidenceSource {
  page: number
  figure?: string
  method: EvidenceMethod
  confidence: EvidenceConfidence
  image?: string
  render_dpi?: number
  note?: string
}

export interface EvidenceField<T> {
  value: T
  sources: EvidenceSource[]
}

export interface PinEvidence {
  number: string
  labels: string[]
  role: SchematicPinRole
  description?: string
  sources: EvidenceSource[]
}

export interface EvidencePad extends ExpectedFootprintPad {
  sources: EvidenceSource[]
}

export interface ComponentEvidence {
  version: 1
  status: "resolved" | "unresolved"
  part_number: EvidenceField<string>
  ordering_code?: EvidenceField<string>
  package: {
    name: EvidenceField<string>
    code?: EvidenceField<string>
    pin_count: EvidenceField<number>
  }
  pinout: {
    pins: PinEvidence[]
  }
  footprint: {
    view: "pcb_top"
    units: "mm"
    drawing_orientation: EvidenceField<DrawingOrientation>
    pads: EvidencePad[]
  }
  unresolved_ambiguities: string[]
}
