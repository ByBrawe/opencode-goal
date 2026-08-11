export function normalizeLabel(value) {
  return String(value).trim().toUpperCase().replace(/\s+/g, "_")
}
