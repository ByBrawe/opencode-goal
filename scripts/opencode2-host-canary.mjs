import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const pluginID = "bybrawe.open-code-goals.v2-experimental"
const sentinelID = "bybrawe.open-code-goals.v2-canary-sentinel"
const PLUGIN_READY_ATTEMPTS = 10
const PLUGIN_READY_DELAY_MS = 500

function run(command, args, { cwd, env, allowFailure = false, timeout = 60_000 } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout,
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (!allowFailure && result.status !== 0) {
    throw new Error([
      `command failed (${result.status}): ${command} ${args.join(" ")}`,
      String(result.stdout ?? ""),
      String(result.stderr ?? ""),
    ].filter(Boolean).join("\n"))
  }
  return result
}

function output(result) {
  return `${String(result.stdout ?? "")}\n${String(result.stderr ?? "")}`.trim()
}

function parseJSONOutput(result, label) {
  const text = String(result.stdout ?? "").trim()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label} did not return JSON on stdout.\nstdout:\n${text}\nstderr:\n${String(result.stderr ?? "")}`)
  }
}

function collectPluginIDs(value) {
  if (Array.isArray(value)) return value.flatMap(collectPluginIDs)
  if (typeof value === "string") return [value]
  if (!value || typeof value !== "object") return []
  const direct = [value.id, value.pluginID, value.name].filter((item) => typeof item === "string")
  const nested = [value.data, value.plugins, value.items].flatMap((item) => collectPluginIDs(item))
  return [...direct, ...nested]
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fileTextIfPresent(file) {
  try {
    return await readFile(file, "utf8")
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}

async function failureLog(env) {
  const candidates = [
    path.join(env.XDG_DATA_HOME, "opencode", "log", "opencode.log"),
    path.join(env.XDG_STATE_HOME, "opencode", "log", "opencode.log"),
  ]
  for (const file of candidates) {
    try {
      const raw = await readFile(file, "utf8")
      return raw.slice(-30_000)
    } catch {
      // Try the next location.
    }
  }
  return ""
}

async function main() {
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-v2-host-"))
  const project = path.join(temp, "project")
  const home = path.join(temp, "home")
  const config = path.join(home, ".config")
  const data = path.join(home, ".local", "share")
  const state = path.join(home, ".local", "state")
  const opencodeDirectory = path.join(project, ".opencode")
  const pluginDirectory = path.join(opencodeDirectory, "plugins")
  const pluginFile = path.join(root, "dist", "opencode2", "experimental.js")
  const sentinelMarkerFile = path.join(temp, "v2-sentinel-setup-loaded")
  const setupBoundaryTraceFile = path.join(temp, "v2-setup-boundary-trace.jsonl")
  const adapterBridge = path.join(pluginDirectory, "opencode-goals-v2-canary.js")
  const sentinelFile = path.join(pluginDirectory, "00-opencode-goals-v2-sentinel.js")

  await Promise.all([
    mkdir(pluginDirectory, { recursive: true }),
    mkdir(config, { recursive: true }),
    mkdir(data, { recursive: true }),
    mkdir(state, { recursive: true }),
  ])

  await writeFile(
    sentinelFile,
    [
      'import { writeFile } from "node:fs/promises"',
      `export default { id: ${JSON.stringify(sentinelID)}, setup: async () => {`,
      `  await writeFile(${JSON.stringify(sentinelMarkerFile)}, "loaded\\n", "utf8")`,
      "} }",
      "",
    ].join("\n"),
  )
  await writeFile(
    adapterBridge,
    [
      'import { appendFileSync } from "node:fs"',
      `import target from ${JSON.stringify(pathToFileURL(pluginFile).href)}`,
      `const traceFile = ${JSON.stringify(setupBoundaryTraceFile)}`,
      "function trace(event) {",
      '  appendFileSync(traceFile, `${JSON.stringify(event)}\\n`, "utf8")',
      "}",
      "function errorRecord(error) {",
      '  return { name: error?.name ?? typeof error, message: error?.message ?? String(error) }',
      "}",
      "function summarizeValue(value) {",
      '  if (value === null) return { type: "null" }',
      '  if (Array.isArray(value)) return { type: "array", length: value.length }',
      '  if (typeof value === "string") return { type: "string", value: value.slice(0, 160) }',
      '  if (typeof value === "object" || typeof value === "function") {',
      "    return {",
      '      type: typeof value,',
      '      keys: Reflect.ownKeys(value).map(String).slice(0, 30),',
      '      nameType: typeof value?.name,',
      '      idType: typeof value?.id,',
      "    }",
      "  }",
      '  return { type: typeof value }',
      "}",
      "function wrapToolDraft(value) {",
      '  if (!value || (typeof value !== "object" && typeof value !== "function")) return value',
      "  return new Proxy(value, {",
      "    get(targetDraft, prop, receiver) {",
      "      const original = Reflect.get(targetDraft, prop, receiver)",
      '      if (prop !== "add" || typeof original !== "function") return original',
      "      return function (...args) {",
      "        const metadata = {",
      '          phase: "before",',
      '          boundary: "tool.draft.add",',
      "          method: {",
      '            name: original.name,',
      '            length: original.length,',
      '            source: Function.prototype.toString.call(original).slice(0, 800),',
      "          },",
      "          arguments: args.map(summarizeValue),",
      "        }",
      "        trace(metadata)",
      "        try {",
      "          const result = Reflect.apply(original, targetDraft, args)",
      '          trace({ phase: "after", boundary: "tool.draft.add" })',
      "          return result",
      "        } catch (error) {",
      '          trace({ phase: "error", boundary: "tool.draft.add", error: errorRecord(error) })',
      "          throw error",
      "        }",
      "      }",
      "    },",
      "  })",
      "}",
      "function wrapToolTransformCallback(callback) {",
      "  return function (draft, ...rest) {",
      "    trace({",
      '      phase: "callback-enter",',
      '      boundary: "tool.transform",',
      "      draft: {",
      '        keys: draft && (typeof draft === "object" || typeof draft === "function") ? Reflect.ownKeys(draft).map(String).slice(0, 30) : [],',
      '        addType: typeof draft?.add,',
      '        addName: typeof draft?.add === "function" ? draft.add.name : undefined,',
      '        addLength: typeof draft?.add === "function" ? draft.add.length : undefined,',
      "      },",
      "    })",
      "    try {",
      "      const result = Reflect.apply(callback, this, [wrapToolDraft(draft), ...rest])",
      '      trace({ phase: "callback-after", boundary: "tool.transform" })',
      "      return result",
      "    } catch (error) {",
      '      trace({ phase: "callback-error", boundary: "tool.transform", error: errorRecord(error) })',
      "      throw error",
      "    }",
      "  }",
      "}",
      "function wrapMethod(domainName, methodName, targetDomain, targetMethod) {",
      "  return async function (...args) {",
      '    const suffix = domainName === "session" && methodName === "hook" ? `:${String(args[0])}` : ""',
      '    const boundary = `${domainName}.${methodName}${suffix}`',
      '    trace({ phase: "before", boundary })',
      '    const callArgs = domainName === "tool" && methodName === "transform" && typeof args[0] === "function"',
      "      ? [wrapToolTransformCallback(args[0]), ...args.slice(1)]",
      "      : args",
      "    try {",
      "      const result = await Reflect.apply(targetMethod, targetDomain, callArgs)",
      '      trace({ phase: "after", boundary })',
      "      return result",
      "    } catch (error) {",
      '      trace({ phase: "error", boundary, error: errorRecord(error) })',
      "      throw error",
      "    }",
      "  }",
      "}",
      "function wrapDomain(domainName, value) {",
      '  if (!value || (typeof value !== "object" && typeof value !== "function")) return value',
      '  const methodNames = domainName === "command" || domainName === "tool" ? new Set(["transform"]) : domainName === "session" ? new Set(["hook"]) : new Set()',
      "  return new Proxy(value, {",
      "    get(targetDomain, prop, receiver) {",
      "      const original = Reflect.get(targetDomain, prop, receiver)",
      "      if (methodNames.has(String(prop)) && typeof original === \"function\") {",
      "        return wrapMethod(domainName, String(prop), targetDomain, original)",
      "      }",
      "      return original",
      "    },",
      "  })",
      "}",
      "const diagnosticPlugin = {",
      "  id: target.id,",
      "  async setup(ctx) {",
      "    trace({",
      '      phase: "setup-enter",',
      "      domains: {",
      "        command: Boolean(ctx?.command),",
      '        commandTransform: typeof ctx?.command?.transform === "function",',
      "        tool: Boolean(ctx?.tool),",
      '        toolTransform: typeof ctx?.tool?.transform === "function",',
      "        session: Boolean(ctx?.session),",
      '        sessionHook: typeof ctx?.session?.hook === "function",',
      "      },",
      "    })",
      "    const wrappedCtx = new Proxy(ctx, {",
      "      get(targetCtx, prop, receiver) {",
      '        if (prop === "command" || prop === "tool" || prop === "session") {',
      "          return wrapDomain(String(prop), Reflect.get(targetCtx, prop, receiver))",
      "        }",
      "        return Reflect.get(targetCtx, prop, receiver)",
      "      },",
      "    })",
      "    try {",
      "      const cleanup = await target.setup(wrappedCtx)",
      '      trace({ phase: "setup-after" })',
      "      return cleanup",
      "    } catch (error) {",
      '      trace({ phase: "setup-error", error: errorRecord(error) })',
      "      throw error",
      "    }",
      "  },",
      "}",
      "export default diagnosticPlugin",
      "",
    ].join("\n"),
  )
  await writeFile(path.join(project, "README.md"), "# OpenCode 2 host canary\n")
  await writeFile(path.join(project, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
  }, null, 2)}\n`)

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    XDG_STATE_HOME: state,
    OPENCODE_DB: path.join(data, "opencode", "opencode-v2-canary.db"),
    OPENCODE_LOG_LEVEL: "DEBUG",
    CI: "true",
  }

  run("git", ["init", "-q"], { cwd: project, env })
  run("git", ["config", "user.name", "OpenCode Goals Canary"], { cwd: project, env })
  run("git", ["config", "user.email", "opencode-goals-canary@example.invalid"], { cwd: project, env })
  run("git", ["add", "."], { cwd: project, env })
  run("git", ["commit", "-q", "-m", "initialize canary workspace"], { cwd: project, env })

  try {
    run("opencode2", ["service", "stop"], { cwd: project, env, allowFailure: true, timeout: 15_000 })

    const version = output(run("opencode2", ["--version"], { cwd: project, env, timeout: 30_000 }))
    if (!version) throw new Error("opencode2 --version returned no output")

    const health = output(run("opencode2", ["api", "get", "/api/health"], { cwd: project, env }))
    if (!health) throw new Error("OpenCode 2 health API returned no output")

    const pluginPath = `/api/plugin?location%5Bdirectory%5D=${encodeURIComponent(project)}`
    let pluginResult = null
    let response = null
    let ids = []
    let sentinelMarker = null
    let setupBoundaryTrace = null
    const activationAttempts = []

    for (let attempt = 1; attempt <= PLUGIN_READY_ATTEMPTS; attempt += 1) {
      pluginResult = run("opencode2", ["api", "get", pluginPath], { cwd: project, env })
      response = parseJSONOutput(pluginResult, "GET /api/plugin at project Location")

      if (response?._tag) {
        throw new Error(`project-scoped /api/plugin rejected the Location: ${JSON.stringify(response)}`)
      }
      if (response?.location?.directory !== project) {
        throw new Error(`OpenCode 2 resolved the wrong Location: expected ${project}, got ${String(response?.location?.directory)}`)
      }
      if (response?.location?.project?.id === "global") {
        throw new Error(`OpenCode 2 classified the committed git canary workspace as global: ${JSON.stringify(response.location)}`)
      }

      ids = [...new Set(collectPluginIDs(response))]
      sentinelMarker = await fileTextIfPresent(sentinelMarkerFile)
      setupBoundaryTrace = await fileTextIfPresent(setupBoundaryTraceFile)
      const sentinelListed = ids.includes(sentinelID)
      const sentinelSetup = sentinelMarker === "loaded\n"
      const adapterListed = ids.includes(pluginID)
      activationAttempts.push({
        attempt,
        activePluginCount: ids.length,
        sentinelListed,
        sentinelSetup,
        adapterListed,
        setupBoundaryTracePresent: Boolean(setupBoundaryTrace),
      })

      if (sentinelListed && sentinelSetup && adapterListed) break
      if (attempt < PLUGIN_READY_ATTEMPTS) await sleep(PLUGIN_READY_DELAY_MS)
    }

    if (!ids.includes(sentinelID)) {
      throw new Error([
        `OpenCode 2 did not activate the minimal V2 { id, setup } plugin after ${PLUGIN_READY_ATTEMPTS} bounded project-scoped readiness checks.`,
        "The first /api/plugin response may legitimately precede project plugin activation; the canary retries the same service instead of treating that transient empty registry as a permanent incompatibility.",
        `V2 sentinel setup marker written: ${sentinelMarker === "loaded\n"}`,
        `Active V2 IDs: ${JSON.stringify(ids)}`,
        `Activation attempts: ${JSON.stringify(activationAttempts)}`,
        `Setup boundary trace: ${setupBoundaryTrace ?? "<not written>"}`,
        `Last raw response: ${String(pluginResult?.stdout ?? "")}`,
      ].join("\n"))
    }
    if (sentinelMarker !== "loaded\n") {
      throw new Error([
        `OpenCode 2 listed ${sentinelID}, but its setup() side effect did not run after the bounded readiness window.`,
        "Discovery/registry visibility exists, but V2 setup activation is not proven for this beta host.",
        `Active V2 IDs: ${JSON.stringify(ids)}`,
        `Activation attempts: ${JSON.stringify(activationAttempts)}`,
        `Setup boundary trace: ${setupBoundaryTrace ?? "<not written>"}`,
        `Last raw response: ${String(pluginResult?.stdout ?? "")}`,
      ].join("\n"))
    }
    if (!ids.includes(pluginID)) {
      throw new Error([
        `OpenCode 2 activated the V2 sentinel but not ${pluginID}; the Goals adapter module/setup is incompatible with this beta host.`,
        `Active IDs: ${JSON.stringify(ids)}`,
        `Activation attempts: ${JSON.stringify(activationAttempts)}`,
        `Setup boundary trace: ${setupBoundaryTrace ?? "<not written>"}`,
        `Last raw response: ${String(pluginResult?.stdout ?? "")}`,
      ].join("\n"))
    }

    console.log(JSON.stringify({
      ok: true,
      platform: process.platform,
      node: process.version,
      opencode2Version: version,
      health,
      projectDirectory: response.location.directory,
      projectID: response.location.project.id,
      v2SentinelSetupExecuted: true,
      sentinelID,
      pluginID,
      activePluginIDs: ids,
      activationAttempts,
      setupBoundaryTrace,
    }, null, 2))
  } catch (error) {
    const setupBoundaryTrace = await fileTextIfPresent(setupBoundaryTraceFile)
    if (setupBoundaryTrace) console.error(`OpenCode 2 setup boundary trace:\n${setupBoundaryTrace}`)
    const logs = await failureLog(env)
    if (logs) console.error(`OpenCode 2 server log tail:\n${logs}`)
    throw error
  } finally {
    run("opencode2", ["service", "stop"], { cwd: project, env, allowFailure: true, timeout: 15_000 })
    await rm(temp, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})