import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function stringField(value, label) {
  assert(typeof value === "string" && value.trim(), `${label} must be a non-empty string`)
  return value
}

function validateActionSpec(spec, label) {
  if (typeof spec === "string") {
    stringField(spec, label)
    return
  }
  if (Array.isArray(spec)) {
    assert(spec.length > 0, `${label} must not be an empty command sequence`)
    spec.forEach((template, index) => stringField(template, `${label}[${index}]`))
    return
  }
  assert(spec && typeof spec === "object", `${label} must be a command template, command sequence, or unsupported declaration`)
  const keys = Object.keys(spec)
  assert(keys.length === 1 && keys[0] === "unsupported", `${label} object form only accepts unsupported`)
  stringField(spec.unsupported, `${label}.unsupported`)
}

export function validateActionAdapter(value, source = "adapter") {
  assert(value && typeof value === "object" && !Array.isArray(value), `${source} must be an object`)
  assert(value.schemaVersion === 1, `${source}.schemaVersion must be 1`)
  stringField(value.commandName, `${source}.commandName`)
  assert(value.actions && typeof value.actions === "object" && !Array.isArray(value.actions), `${source}.actions must be an object`)
  const entries = Object.entries(value.actions)
  assert(entries.length > 0, `${source}.actions must be non-empty`)
  for (const [action, spec] of entries) {
    stringField(action, `${source}.actions key`)
    validateActionSpec(spec, `${source}.actions.${action}`)
  }
  return value
}

export function parseCanonicalAction(raw) {
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error("canonical benchmark action must be valid JSON")
  }
  assert(value && typeof value === "object" && !Array.isArray(value), "canonical benchmark action must be an object")
  const action = stringField(value.action, "canonical action.action")
  const fields = {}
  for (const [key, child] of Object.entries(value)) {
    if (key === "action") continue
    assert(["string", "number", "boolean"].includes(typeof child), `canonical action.${key} must be a string, number, or boolean`)
    fields[key] = String(child)
  }
  return { action, fields }
}

function materializeTemplate(template, fields, action) {
  const rawArguments = template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_match, key) => {
    assert(Object.prototype.hasOwnProperty.call(fields, key), `canonical action ${action} is missing template field ${key}`)
    return fields[key]
  })
  const unresolved = rawArguments.match(/\{[A-Za-z][A-Za-z0-9_]*\}/)
  assert(!unresolved, `adapter template left unresolved placeholder ${unresolved?.[0]}`)
  return rawArguments
}

export function materializeSemanticAction(adapter, canonical) {
  validateActionAdapter(adapter)
  const parsed = typeof canonical === "string" ? parseCanonicalAction(canonical) : canonical
  stringField(parsed?.action, "canonical action.action")
  const spec = adapter.actions[parsed.action]
  assert(spec !== undefined, `adapter does not support canonical action ${parsed.action}`)
  if (spec && typeof spec === "object" && !Array.isArray(spec)) {
    throw new Error(`BENCHMARK_CAPABILITY_UNSUPPORTED: canonical action ${parsed.action}: ${spec.unsupported}`)
  }
  const fields = parsed.fields ?? {}
  const templates = Array.isArray(spec) ? spec : [spec]
  const rawArguments = templates.map((template) => materializeTemplate(template, fields, parsed.action))
  return {
    commandName: adapter.commandName,
    rawArguments: rawArguments.length === 1 ? rawArguments[0] : rawArguments,
  }
}

async function loadAdapter(file) {
  const absolute = path.resolve(file)
  const value = JSON.parse(await readFile(absolute, "utf8"))
  return validateActionAdapter(value, absolute)
}

function runDriver(commandName, rawArguments) {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const driver = path.join(here, "opencode-stateful-run.mjs")
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [driver, commandName, rawArguments], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
      shell: false,
    })
    child.once("error", reject)
    child.once("close", (code, signal) => resolve({ code, signal }))
  })
}

export async function main(argv = process.argv.slice(2)) {
  const [adapterPath, canonicalRaw, ...extra] = argv
  if (!adapterPath || canonicalRaw === undefined || extra.length) {
    throw new Error("Usage: node scripts/benchmark/semantic-action-adapter.mjs <adapter.json> <canonical-action-json>")
  }
  const adapter = await loadAdapter(adapterPath)
  const action = materializeSemanticAction(adapter, canonicalRaw)
  const sequence = Array.isArray(action.rawArguments) ? action.rawArguments : [action.rawArguments]
  for (const rawArguments of sequence) {
    const result = await runDriver(action.commandName, rawArguments)
    if (result.signal) {
      process.kill(process.pid, result.signal)
      return
    }
    if ((result.code ?? 1) !== 0) {
      process.exitCode = result.code ?? 1
      return
    }
  }
  process.exitCode = 0
}

const invoked = process.argv[1] ? pathToFileURLSafe(path.resolve(process.argv[1])) : null
function pathToFileURLSafe(value) {
  return new URL(`file://${value.split(path.sep).join("/")}`).href
}

if (invoked === import.meta.url) {
  main().catch((error) => {
    console.error(error?.stack || error)
    process.exitCode = 1
  })
}
