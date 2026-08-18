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

function diagnosticAdapterBridge(pluginURL, stageFile) {
  return [
    'import { appendFileSync } from "node:fs"',
    `import plugin from ${JSON.stringify(pluginURL)}`,
    `const stageFile = ${JSON.stringify(stageFile)}`,
    'function mark(text) { try { appendFileSync(stageFile, String(text) + "\\n", "utf8") } catch {} }',
    'function describe(error) { return String(error?.message ?? error).replace(/\\s+/g, " ").slice(0, 500) }',
    'function settle(value, label) {',
    '  if (value && typeof value.then === "function") {',
    '    return value.then(',
    '      (result) => { mark(label + ":after"); return result },',
    '      (error) => { mark(label + ":error:" + describe(error)); throw error },',
    '    )',
    '  }',
    '  mark(label + ":after")',
    '  return value',
    '}',
    'function wrapCallback(callback, label) {',
    '  if (typeof callback !== "function") return callback',
    '  return function (...args) {',
    '    mark(label + ":callback:before")',
    '    try {',
    '      const value = callback.apply(this, args)',
    '      if (value && typeof value.then === "function") {',
    '        return value.then(',
    '          (result) => { mark(label + ":callback:after"); return result },',
    '          (error) => { mark(label + ":callback:error:" + describe(error)); throw error },',
    '        )',
    '      }',
    '      mark(label + ":callback:after")',
    '      return value',
    '    } catch (error) {',
    '      mark(label + ":callback:error:" + describe(error))',
    '      throw error',
    '    }',
    '  }',
    '}',
    'function wrapTransform(target, label) {',
    '  if (!target || typeof target.transform !== "function") return target',
    '  const original = target.transform',
    '  return new Proxy(target, {',
    '    get(object, property, receiver) {',
    '      if (property !== "transform") return Reflect.get(object, property, receiver)',
    '      return function (callback, ...rest) {',
    '        mark(label + ":before")',
    '        try {',
    '          return settle(original.call(target, wrapCallback(callback, label), ...rest), label)',
    '        } catch (error) {',
    '          mark(label + ":error:" + describe(error))',
    '          throw error',
    '        }',
    '      }',
    '    },',
    '  })',
    '}',
    'function wrapSession(target) {',
    '  if (!target || typeof target.hook !== "function") return target',
    '  const original = target.hook',
    '  return new Proxy(target, {',
    '    get(object, property, receiver) {',
    '      if (property !== "hook") return Reflect.get(object, property, receiver)',
    '      return function (name, ...rest) {',
    '        const label = "session.hook:" + String(name)',
    '        mark(label + ":before")',
    '        try {',
    '          return settle(original.call(target, name, ...rest), label)',
    '        } catch (error) {',
    '          mark(label + ":error:" + describe(error))',
    '          throw error',
    '        }',
    '      }',
    '    },',
    '  })',
    '}',
    'function wrapContext(ctx) {',
    '  const command = wrapTransform(ctx?.command, "command.transform")',
    '  const tool = wrapTransform(ctx?.tool, "tool.transform")',
    '  const session = wrapSession(ctx?.session)',
    '  return new Proxy(ctx, {',
    '    get(object, property, receiver) {',
    '      if (property === "command") return command',
    '      if (property === "tool") return tool',
    '      if (property === "session") return session',
    '      return Reflect.get(object, property, receiver)',
    '    },',
    '  })',
    '}',
    'mark("bridge:loaded")',
    'export default {',
    '  ...plugin,',
    '  setup: async (ctx) => {',
    '    mark("setup:before")',
    '    try {',
    '      const result = await plugin.setup(wrapContext(ctx))',
    '      mark("setup:after")',
    '      return result',
    '    } catch (error) {',
    '      mark("setup:error:" + describe(error))',
    '      throw error',
    '    }',
    '  },',
    '}',
    '',
  ].join("\n")
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
  const adapterStageFile = path.join(temp, "v2-adapter-setup-stages.log")
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
    diagnosticAdapterBridge(pathToFileURL(pluginFile).href, adapterStageFile),
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
      const sentinelListed = ids.includes(sentinelID)
      const sentinelSetup = sentinelMarker === "loaded\n"
      const adapterListed = ids.includes(pluginID)
      activationAttempts.push({
        attempt,
        activePluginCount: ids.length,
        sentinelListed,
        sentinelSetup,
        adapterListed,
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
        `Last raw response: ${String(pluginResult?.stdout ?? "")}`,
      ].join("\n"))
    }
    if (sentinelMarker !== "loaded\n") {
      throw new Error([
        `OpenCode 2 listed ${sentinelID}, but its setup() side effect did not run after the bounded readiness window.`,
        "Discovery/registry visibility exists, but V2 setup activation is not proven for this beta host.",
        `Active V2 IDs: ${JSON.stringify(ids)}`,
        `Activation attempts: ${JSON.stringify(activationAttempts)}`,
        `Last raw response: ${String(pluginResult?.stdout ?? "")}`,
      ].join("\n"))
    }
    if (!ids.includes(pluginID)) {
      const adapterStages = await fileTextIfPresent(adapterStageFile)
      throw new Error([
        `OpenCode 2 activated the V2 sentinel but not ${pluginID}; the Goals adapter module/setup is incompatible with this beta host.`,
        `Active IDs: ${JSON.stringify(ids)}`,
        `Activation attempts: ${JSON.stringify(activationAttempts)}`,
        `Adapter setup stages:\n${adapterStages ?? "<no stage markers written>"}`,
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
    }, null, 2))
  } catch (error) {
    const adapterStages = await fileTextIfPresent(adapterStageFile)
    if (adapterStages) console.error(`OpenCode 2 adapter setup stages:\n${adapterStages}`)
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
