import { MAX_PDF_BYTES } from "./job-api-context"

export function validatePdf(file: File, pdf_bytes: Uint8Array): string | undefined {
  if (file.size === 0) return "The selected PDF is empty."
  if (file.size > MAX_PDF_BYTES) return "Datasheets must be 30 MB or smaller."
  if (!file.name.toLowerCase().endsWith(".pdf")) return "Upload a PDF datasheet."
  if (new TextDecoder().decode(pdf_bytes.slice(0, 5)) !== "%PDF-")
    return "The selected file is not a valid PDF."
  return undefined
}
