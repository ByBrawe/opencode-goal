import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const pluginID = "bybrawe.open-code-goals.v2-experimental"
const sentinelID = "bybrawe.open-code-goals.v2-canary-sentinel"
const discoverySentinelID = "bybrawe.open-code-goals.v2-discovery-sentinel"

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

function markerPlugin(id, markerFile) {
  return [
    'import { writeFile } from "node:fs/promises"',
    `export default { id: ${JSON.stringify(id)}, setup: async () => {`,
    `  await writeFile(${JSON.stringify(markerFile)}, "loaded\\n", "utf8")`,
    "} }",
    "",
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
  const explicitDirectory = path.join(opencodeDirectory, "v2-canary")
  const discoveryDirectory = path.join(opencodeDirectory, "plugins")
  const pluginFile = path.join(root, "dist", "opencode2", "experimental.js")
  const sentinelMarkerFile = path.join(temp, "v2-explicit-sentinel-setup-loaded")
  const discoveryMarkerFile = path.join(temp, "v2-discovery-sentinel-setup-loaded")
  const adapterBridge = path.join(explicitDirectory, "opencode-goals-v2-canary.js")
  const sentinelFile = path.join(explicitDirectory, "00-opencode-goals-v2-sentinel.js")
  const discoverySentinelFile = path.join(discoveryDirectory, "00-opencode-goals-v2-discovery-sentinel.js")

  await Promise.all([
    mkdir(explicitDirectory, { recursive: true }),
    mkdir(discoveryDirectory, { recursive: true }),
    mkdir(config, { recursive: true }),
    mkdir(data, { recursive: true }),
    mkdir(state, { recursive: true }),
  ])

  await writeFile(sentinelFile, markerPlugin(sentinelID, sentinelMarkerFile))
  await writeFile(discoverySentinelFile, markerPlugin(discoverySentinelID, discoveryMarkerFile))
  await writeFile(
    adapterBridge,
    `export { default } from ${JSON.stringify(pathToFileURL(pluginFile).href)}\n`,
  )
  await writeFile(path.join(project, "README.md"), "# OpenCode 2 host canary\n")
  await writeFile(path.join(project, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    plugins: [
      "./.opencode/v2-canary/00-opencode-goals-v2-sentinel.js",
      "./.opencode/v2-canary/opencode-goals-v2-canary.js",
    ],
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
    const pluginResult = run("opencode2", ["api", "get", pluginPath], { cwd: project, env })
    const response = parseJSONOutput(pluginResult, "GET /api/plugin at project Location")

    if (response?._tag) {
      throw new Error(`project-scoped /api/plugin rejected the Location: ${JSON.stringify(response)}`)
    }
    if (response?.location?.directory !== project) {
      throw new Error(`OpenCode 2 resolved the wrong Location: expected ${project}, got ${String(response?.location?.directory)}`)
    }
    if (response?.location?.project?.id === "global") {
      throw new Error(`OpenCode 2 classified the committed git canary workspace as global: ${JSON.stringify(response.location)}`)
    }

    const ids = [...new Set(collectPluginIDs(response))]
    const sentinelMarker = await fileTextIfPresent(sentinelMarkerFile)
    const discoveryMarker = await fileTextIfPresent(discoveryMarkerFile)
    const discoveryListed = ids.includes(discoverySentinelID)
    const discoverySetupExecuted = discoveryMarker === "loaded\n"

    if (!ids.includes(sentinelID)) {
      throw new Error([
        "OpenCode 2 resolved the project Location, but did not activate the explicitly configured minimal V2 { id, setup } sentinel.",
        "The required activation gate uses the documented `plugins` local-path configuration so upstream auto-discovery churn is measured separately.",
        `Explicit sentinel setup marker written: ${sentinelMarker === "loaded\n"}`,
        `Auto-discovery sentinel listed: ${discoveryListed}`,
        `Auto-discovery sentinel setup marker written: ${discoverySetupExecuted}`,
        `Active V2 IDs: ${JSON.stringify(ids)}`,
        `Raw response: ${String(pluginResult.stdout ?? "")}`,
      ].join("\n"))
    }
    if (sentinelMarker !== "loaded\n") {
      throw new Error([
        `OpenCode 2 listed ${sentinelID}, but its explicitly configured setup() side effect did not run.`,
        "Registry visibility exists, but V2 setup activation is not proven for this beta host.",
        `Active V2 IDs: ${JSON.stringify(ids)}`,
        `Raw response: ${String(pluginResult.stdout ?? "")}`,
      ].join("\n"))
    }
    if (!ids.includes(pluginID)) {
      throw new Error([
        `OpenCode 2 activated the explicitly configured V2 sentinel but not ${pluginID}.`,
        "The Goals adapter module/setup is incompatible with this beta host; auto-discovery is not used to decide this assertion.",
        `Auto-discovery sentinel listed: ${discoveryListed}`,
        `Auto-discovery sentinel setup marker written: ${discoverySetupExecuted}`,
        `Active IDs: ${JSON.stringify(ids)}`,
        `Raw response: ${String(pluginResult.stdout ?? "")}`,
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
      explicitSentinelSetupExecuted: true,
      sentinelID,
      pluginID,
      autoDiscovery: {
        sentinelID: discoverySentinelID,
        listed: discoveryListed,
        setupExecuted: discoverySetupExecuted,
        observed: discoveryListed && discoverySetupExecuted,
      },
      activePluginIDs: ids,
    }, null, 2))
  } catch (error) {
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
