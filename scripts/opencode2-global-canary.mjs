import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const pluginID = "bybrawe.open-code-goals.v2-experimental"
const sentinelID = "bybrawe.open-code-goals.v2-global-canary"

function run(command, args, { cwd, env, allowFailure = false, timeout = 45_000 } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout })
  if (result.error) throw result.error
  if (!allowFailure && result.status !== 0) {
    throw new Error(`command failed (${result.status}): ${command} ${args.join(" ")}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`)
  }
  return result
}

function parseJSON(result, label) {
  const text = String(result.stdout ?? "").trim()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label} did not return JSON.\nstdout:\n${text}\nstderr:\n${result.stderr ?? ""}`)
  }
}

function pluginIDs(response) {
  if (Array.isArray(response)) return response.map(String)
  if (Array.isArray(response?.data)) return response.data.map(String)
  return []
}

async function logTail(env) {
  const candidates = [
    path.join(env.XDG_DATA_HOME, "opencode", "log", "opencode.log"),
    path.join(env.XDG_STATE_HOME, "opencode", "log", "opencode.log"),
  ]
  for (const file of candidates) {
    try {
      return (await readFile(file, "utf8")).slice(-20_000)
    } catch {
      // try next location
    }
  }
  return ""
}

async function main() {
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-v2-global-"))
  const home = path.join(temp, "home")
  const project = path.join(temp, "project")
  const configHome = path.join(home, ".config")
  const opencodeConfig = path.join(configHome, "opencode")
  const globalPlugins = path.join(opencodeConfig, "plugins")
  const dataHome = path.join(home, ".local", "share")
  const stateHome = path.join(home, ".local", "state")
  const adapterFile = path.join(root, "dist", "opencode2", "experimental.js")
  const sentinelFile = path.join(globalPlugins, "goals-v2-sentinel.js")
  const adapterWrapper = path.join(globalPlugins, "goals-v2-adapter.js")

  await Promise.all([
    mkdir(project, { recursive: true }),
    mkdir(globalPlugins, { recursive: true }),
    mkdir(dataHome, { recursive: true }),
    mkdir(stateHome, { recursive: true }),
  ])

  await writeFile(path.join(opencodeConfig, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
  }, null, 2)}\n`)
  await writeFile(sentinelFile, `export default { id: ${JSON.stringify(sentinelID)}, setup: async () => {} }\n`)
  await writeFile(adapterWrapper, `export { default } from ${JSON.stringify(pathToFileURL(adapterFile).href)}\n`)
  await writeFile(path.join(project, "README.md"), "# OpenCode 2 global plugin canary\n")

  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
    XDG_STATE_HOME: stateHome,
    OPENCODE_DB: path.join(dataHome, "opencode", "opencode-next.db"),
    OPENCODE_LOG_LEVEL: "DEBUG",
  }

  run("git", ["init", "-q"], { cwd: project, env })
  run("git", ["config", "user.name", "OpenCode Goals Canary"], { cwd: project, env })
  run("git", ["config", "user.email", "opencode-goals-canary@example.invalid"], { cwd: project, env })
  run("git", ["add", "README.md"], { cwd: project, env })
  run("git", ["commit", "-q", "-m", "initialize canary workspace"], { cwd: project, env })

  try {
    run("opencode2", ["service", "stop"], { cwd: project, env, allowFailure: true, timeout: 15_000 })
    const version = String(run("opencode2", ["--version"], { cwd: project, env }).stdout ?? "").trim()
    if (!version) throw new Error("opencode2 --version returned no output")

    const health = String(run("opencode2", ["api", "get", "/api/health"], { cwd: project, env }).stdout ?? "").trim()
    if (!health) throw new Error("OpenCode 2 health API returned no output")

    const pluginPath = `/api/plugin?location%5Bdirectory%5D=${encodeURIComponent(project)}`
    const pluginResult = run("opencode2", ["api", "get", pluginPath], { cwd: project, env })
    const response = parseJSON(pluginResult, "GET /api/plugin")
    if (response?.location?.directory !== project) {
      throw new Error(`wrong OpenCode 2 Location: expected ${project}, got ${String(response?.location?.directory)}`)
    }
    if (response?.location?.project?.id === "global") {
      throw new Error(`committed canary workspace was still classified as global: ${JSON.stringify(response.location)}`)
    }

    const ids = pluginIDs(response)
    if (!ids.includes(sentinelID)) {
      throw new Error(`Current @opencode-ai/cli@next did not activate the documented global ~/.config/opencode/plugins discovery path. This is a host/plugin-loading compatibility failure, not a Goals adapter failure. Active IDs: ${JSON.stringify(ids)}\nRaw response: ${String(pluginResult.stdout ?? "")}`)
    }
    if (!ids.includes(pluginID)) {
      throw new Error(`Global sentinel loaded but ${pluginID} did not; the Goals V2 adapter module/setup is incompatible with this host. Active IDs: ${JSON.stringify(ids)}\nRaw response: ${String(pluginResult.stdout ?? "")}`)
    }

    console.log(`OpenCode 2 version: ${version}`)
    console.log(`Location: ${project}`)
    console.log(`sentinel ${sentinelID}: LOADED`)
    console.log(`plugin ${pluginID}: LOADED`)
    console.log("real OpenCode 2 global plugin canary PASS")
  } catch (error) {
    const logs = await logTail(env)
    if (logs) console.error(`OpenCode 2 log tail:\n${logs}`)
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
