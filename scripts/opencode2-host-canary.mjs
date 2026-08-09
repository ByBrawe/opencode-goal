import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

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

function localPluginSpecifier(project, file) {
  const relative = path.relative(project, file).replaceAll(path.sep, "/")
  return relative.startsWith(".") ? relative : `./${relative}`
}

async function failureLog(env) {
  const file = path.join(env.XDG_DATA_HOME, "opencode", "log", "opencode.log")
  try {
    const raw = await readFile(file, "utf8")
    return raw.slice(-16_000)
  } catch {
    return ""
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-v2-host-"))
  const project = path.join(temp, "project")
  const home = path.join(temp, "home")
  const config = path.join(temp, "config")
  const data = path.join(temp, "data")
  const state = path.join(temp, "state")
  const pluginFile = path.join(root, "dist", "opencode2", "experimental.js")

  await Promise.all([
    mkdir(project, { recursive: true }),
    mkdir(home, { recursive: true }),
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
    OPENCODE_DB: path.join(data, "opencode-next.db"),
    OPENCODE_LOG_LEVEL: "DEBUG",
  }

  await writeFile(path.join(project, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    plugins: [localPluginSpecifier(project, pluginFile)],
  }, null, 2)}\n`)

  let version = ""
  let health = ""
  let plugins = ""
  let gate = false
  try {
    run("opencode2", ["service", "stop"], { cwd: project, env, allowFailure: true, timeout: 15_000 })

    const versionResult = run("opencode2", ["--version"], { cwd: project, env, timeout: 30_000 })
    version = output(versionResult)
    if (!version) throw new Error("opencode2 --version returned no output")

    const healthResult = run("opencode2", ["api", "get", "/api/health"], { cwd: project, env })
    health = output(healthResult)
    if (!health) throw new Error("OpenCode 2 health API returned no output")

    const pluginResult = run("opencode2", ["api", "get", "/api/plugin"], { cwd: project, env })
    plugins = output(pluginResult)
    if (!plugins.includes(pluginID)) {
      throw new Error(`OpenCode 2 plugin API did not report ${pluginID}.\n${plugins}`)
    }

    gate = true
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      pluginID,
      pluginSpecifier: localPluginSpecifier(project, pluginFile),
      opencode2Version: version,
      health,
      pluginAPIContainsExpectedID: true,
      gate,
    }

    console.log(`OpenCode 2 version: ${version}`)
    console.log(`health: ${health}`)
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
