import type { AnyCircuitElement } from "circuit-json"
import {
  ComponentEvidence,
  DrawingOrientation,
  EvidenceField,
  EvidencePad,
  EvidenceSource,
  PinEvidence,
  SchematicPinRole,
} from "./types"
import { normalizePin } from "./get-pad-agreement-errors"

export type CircuitRecord = AnyCircuitElement & Record<string, unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function requiredFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`)
  }
  return value
}

function parseSources(value: unknown, label: string): EvidenceSource[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must cite at least one evidence source`)
  }
  return value.map((source, index) => {
    const source_label = `${label}[${index}]`
    if (!isRecord(source) || !Number.isInteger(source.page) || (source.page as number) < 1) {
      throw new Error(`${source_label}.page must be a positive PDF page number`)
    }
    if (
      source.method !== "pdf_text" &&
      source.method !== "pdf_visual" &&
      source.method !== "calculated" &&
      source.method !== "package_standard"
    ) {
      throw new Error(`${source_label}.method is invalid`)
    }
    if (source.confidence !== "high" && source.confidence !== "medium" && source.confidence !== "low") {
      throw new Error(`${source_label}.confidence is invalid`)
    }
    const parsed: EvidenceSource = {
      page: source.page as number,
      method: source.method,
      confidence: source.confidence,
      ...(source.figure === undefined
        ? {}
        : { figure: requiredText(source.figure, `${source_label}.figure`) }),
      ...(source.image === undefined ? {} : { image: requiredText(source.image, `${source_label}.image`) }),
      ...(source.render_dpi === undefined
        ? {}
        : { render_dpi: requiredFiniteNumber(source.render_dpi, `${source_label}.render_dpi`) }),
      ...(source.note === undefined ? {} : { note: requiredText(source.note, `${source_label}.note`) }),
    }
    if (parsed.method === "pdf_visual" && (!parsed.image || parsed.render_dpi !== 200)) {
      throw new Error(`${source_label} must record an image rendered at exactly 200 DPI`)
    }
    if ((parsed.method === "calculated" || parsed.method === "package_standard") && !parsed.note) {
      throw new Error(`${source_label} must explain its ${parsed.method} source in note`)
    }
    if (
      parsed.image &&
      (parsed.image.startsWith("/") || parsed.image.split(/[\\/]/).some((segment) => segment === ".."))
    ) {
      throw new Error(`${source_label}.image must be a relative path inside the evidence workspace`)
    }
    return parsed
  })
}

function parseField<T>(input: {
  value: unknown
  label: string
  parse_value: (field_value: unknown, field_label: string) => T
}): EvidenceField<T> {
  const { value, label, parse_value } = input
  if (!isRecord(value)) throw new Error(`${label} must contain value and sources`)
  return {
    value: parse_value(value.value, `${label}.value`),
    sources: parseSources(value.sources, `${label}.sources`),
  }
}

function parsePad(value: unknown, index: number): EvidencePad {
  const label = `component evidence footprint.pads[${index}]`
  if (!isRecord(value) || (value.kind !== "smt" && value.kind !== "plated_hole")) {
    throw new Error(`${label}.kind must be smt or plated_hole`)
  }
  const pad: EvidencePad = {
    pin: value.pin === null ? null : requiredText(value.pin, `${label}.pin`),
    kind: value.kind,
    x: requiredFiniteNumber(value.x, `${label}.x`),
    y: requiredFiniteNumber(value.y, `${label}.y`),
    width: requiredFiniteNumber(value.width, `${label}.width`),
    height: requiredFiniteNumber(value.height, `${label}.height`),
    ...(value.hole_width === undefined
      ? {}
      : { hole_width: requiredFiniteNumber(value.hole_width, `${label}.hole_width`) }),
    ...(value.hole_height === undefined
      ? {}
      : { hole_height: requiredFiniteNumber(value.hole_height, `${label}.hole_height`) }),
    sources: parseSources(value.sources, `${label}.sources`),
  }
  if (pad.width <= 0 || pad.height <= 0) throw new Error(`${label} dimensions must be positive`)
  if (
    pad.kind === "plated_hole" &&
    (!pad.hole_width || !pad.hole_height || pad.hole_width <= 0 || pad.hole_height <= 0)
  ) {
    throw new Error(`${label} must include positive hole dimensions`)
  }
  return pad
}

export function parseComponentEvidence(value: unknown): ComponentEvidence {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    (value.status !== "resolved" && value.status !== "unresolved")
  ) {
    throw new Error("component-evidence.json must have version 1 and a valid status")
  }
  if (!isRecord(value.package)) throw new Error("component evidence package must be an object")
  if (!isRecord(value.pinout)) throw new Error("component evidence pinout must be an object")
  if (!isRecord(value.footprint) || value.footprint.view !== "pcb_top" || value.footprint.units !== "mm") {
    throw new Error('component evidence footprint must use view "pcb_top" and units "mm"')
  }
  if (!Array.isArray(value.pinout.pins) || (value.status === "resolved" && value.pinout.pins.length === 0)) {
    throw new Error("component evidence must contain a complete pin table")
  }
  const seen_pins = new Set<string>()
  const pin_roles = new Set<SchematicPinRole>([
    "power_input",
    "power_output",
    "ground",
    "input",
    "output",
    "bidirectional",
    "passive",
    "no_connect",
    "other",
  ])
  const pins = value.pinout.pins.map((pin, index): PinEvidence => {
    const label = `component evidence pinout.pins[${index}]`
    if (!isRecord(pin) || !Array.isArray(pin.labels) || pin.labels.length === 0) {
      throw new Error(`${label} must contain a number, labels, role, and sources`)
    }
    const number = requiredText(pin.number, `${label}.number`)
    const normalized_number = normalizePin(number)
    if (seen_pins.has(normalized_number)) throw new Error(`component evidence pin ${number} is duplicated`)
    seen_pins.add(normalized_number)
    if (typeof pin.role !== "string" || !pin_roles.has(pin.role as SchematicPinRole)) {
      throw new Error(`${label}.role is invalid`)
    }
    return {
      number,
      labels: pin.labels.map((pin_label, label_index) =>
        requiredText(pin_label, `${label}.labels[${label_index}]`),
      ),
      role: pin.role as SchematicPinRole,
      ...(pin.description === undefined
        ? {}
        : { description: requiredText(pin.description, `${label}.description`) }),
      sources: parseSources(pin.sources, `${label}.sources`),
    }
  })
  if (
    !Array.isArray(value.footprint.pads) ||
    (value.status === "resolved" && value.footprint.pads.length === 0)
  ) {
    throw new Error("component evidence must contain every copper pad")
  }
  const orientation_values = new Set<DrawingOrientation>([
    "pcb_top",
    "package_top",
    "package_bottom",
    "side",
    "unknown",
  ])
  const pin_count = parseField({
    value: value.package.pin_count,
    label: "component evidence package.pin_count",
    parse_value: (count) => {
      if (!Number.isInteger(count) || (count as number) < 1) {
        throw new Error("component evidence package.pin_count.value must be a positive integer")
      }
      return count as number
    },
  })
  const drawing_orientation = parseField({
    value: value.footprint.drawing_orientation,
    label: "component evidence footprint.drawing_orientation",
    parse_value: (orientation, label) => {
      if (typeof orientation !== "string" || !orientation_values.has(orientation as DrawingOrientation)) {
        throw new Error(`${label} is invalid`)
      }
      return orientation as DrawingOrientation
    },
  })
  if (!Array.isArray(value.unresolved_ambiguities)) {
    throw new Error("component evidence unresolved_ambiguities must be an array")
  }
  return {
    version: 1,
    status: value.status,
    part_number: parseField({
      value: value.part_number,
      label: "component evidence part_number",
      parse_value: requiredText,
    }),
    ...(value.ordering_code === undefined
      ? {}
      : {
          ordering_code: parseField({
            value: value.ordering_code,
            label: "component evidence ordering_code",
            parse_value: requiredText,
          }),
        }),
    package: {
      name: parseField({
        value: value.package.name,
        label: "component evidence package.name",
        parse_value: requiredText,
      }),
      ...(value.package.code === undefined
        ? {}
        : {
            code: parseField({
              value: value.package.code,
              label: "component evidence package.code",
              parse_value: requiredText,
            }),
          }),
      pin_count,
    },
    pinout: { pins },
    footprint: {
      view: "pcb_top",
      units: "mm",
      drawing_orientation,
      pads: value.footprint.pads.map(parsePad),
    },
    unresolved_ambiguities: value.unresolved_ambiguities.map((ambiguity, index) =>
      requiredText(ambiguity, `component evidence unresolved_ambiguities[${index}]`),
    ),
  }
}
