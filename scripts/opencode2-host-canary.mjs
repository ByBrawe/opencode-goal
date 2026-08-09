import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const pluginID = "bybrawe.open-code-goals.v2-experimental"

function parseArgs(argv) {
  const options = { jsonPath: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--json") {
      const value = argv[++i]
      if (!value) throw new Error("--json expects a file path")
      options.jsonPath = value
      continue
    }
    if (arg.startsWith("--json=")) {
      options.jsonPath = arg.slice("--json=".length)
      continue
    }
    throw new Error(`unknown OpenCode 2 canary option: ${arg}`)
  }
  return options
}

function run(command, args, { cwd, env, allowFailure = false, timeout = 45_000 } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout,
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

function pluginIDs(value) {
  if (Array.isArray(value)) return value.map(String)
  if (Array.isArray(value?.data)) return value.data.map(String)
  return []
}

async function failureLog(env) {
  const candidates = [
    path.join(env.XDG_DATA_HOME, "opencode", "log", "opencode.log"),
    path.join(env.XDG_STATE_HOME, "opencode", "log", "opencode.log"),
  ]
  for (const file of candidates) {
    try {
      const raw = await readFile(file, "utf8")
      return raw.slice(-20_000)
    } catch {
      // Try the next documented/legacy state location.
    }
  }
  return ""
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-v2-host-"))
  const project = path.join(temp, "project")
  const home = path.join(temp, "home")
  const config = path.join(home, ".config")
  const projectConfig = path.join(project, ".opencode")
  const pluginDirectory = path.join(projectConfig, "plugins")
  const data = path.join(home, ".local", "share")
  const state = path.join(home, ".local", "state")
  const pluginFile = path.join(root, "dist", "opencode2", "experimental.js")
  const discoveryFile = path.join(pluginDirectory, "opencode-goals-v2-canary.js")

  await Promise.all([
    mkdir(pluginDirectory, { recursive: true }),
    mkdir(config, { recursive: true }),
    mkdir(data, { recursive: true }),
    mkdir(state, { recursive: true }),
  ])

  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    XDG_STATE_HOME: state,
    OPENCODE_DB: path.join(data, "opencode", "opencode-next.db"),
    OPENCODE_LOG_LEVEL: "DEBUG",
  }

  await writeFile(path.join(projectConfig, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
  }, null, 2)}\n`)
  await writeFile(
    discoveryFile,
    `export { default } from ${JSON.stringify(pathToFileURL(pluginFile).href)}\n`,
  )

  let version = ""
  let health = ""
  try {
    run("opencode2", ["service", "stop"], { cwd: project, env, allowFailure: true, timeout: 15_000 })

    const versionResult = run("opencode2", ["--version"], { cwd: project, env, timeout: 30_000 })
    version = output(versionResult)
    if (!version) throw new Error("opencode2 --version returned no output")

    const healthResult = run("opencode2", ["api", "get", "/api/health"], { cwd: project, env })
    health = output(healthResult)
    if (!health) throw new Error("OpenCode 2 health API returned no output")

    // The V2 CLI accepts OpenAPI operation IDs and builds object parameters
    // from dotted --param keys. This avoids depending on the beta client npm
    // package while still asking the real service for the explicit project
    // Location rather than the CLI's default global location.
    const pluginResult = run("opencode2", [
      "api",
      "v2.plugin.list",
      "--param",
      `location.directory=${project}`,
    ], { cwd: project, env })
    const pluginResponse = parseJSONOutput(pluginResult, "v2.plugin.list")
    if (pluginResponse?._tag) {
      throw new Error(`v2.plugin.list rejected the project Location: ${JSON.stringify(pluginResponse)}`)
    }
    const ids = pluginIDs(pluginResponse)
    if (!ids.includes(pluginID)) {
      throw new Error(`OpenCode 2 project Location did not activate ${pluginID}. Active IDs: ${JSON.stringify(ids)}\nRaw response: ${String(pluginResult.stdout ?? "")}`)
    }

    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      pluginID,
      pluginSpecifier: pathToFileURL(pluginFile).href,
      discoveryFile,
      configScope: "isolated-project-auto-discovery",
      projectLocation: project,
      opencode2Version: version,
      health,
      pluginAPIContainsExpectedID: true,
      gate: true,
    }

    console.log(`OpenCode 2 version: ${version}`)
    console.log(`health: ${health}`)
    console.log(`location: ${project}`)
    console.log(`plugin ${pluginID}: LOADED`)
    console.log("real OpenCode 2 plugin canary PASS")

    if (options.jsonPath) {
      const target = path.resolve(root, options.jsonPath)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, `${JSON.stringify(report, null, 2)}\n`)
      console.log(`report ${path.relative(root, target).replaceAll(path.sep, "/")}`)
    }
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
