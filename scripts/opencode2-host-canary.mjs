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

async function failureLog(env) {
  const candidates = [
    path.join(env.XDG_DATA_HOME, "opencode", "log", "opencode.log"),
    path.join(env.XDG_STATE_HOME, "opencode", "log", "opencode.log"),
  ]
  for (const file of candidates) {
    try {
      const raw = await readFile(file, "utf8")
      return raw.slice(-16_000)
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
  const pluginDirectory = path.join(config, "opencode", "plugins")
  const data = path.join(home, ".local", "share")
  const state = path.join(home, ".local", "state")
  const pluginFile = path.join(root, "dist", "opencode2", "experimental.js")
  const discoveryFile = path.join(pluginDirectory, "opencode-goals-v2-canary.mjs")

  await Promise.all([
    mkdir(project, { recursive: true }),
    mkdir(pluginDirectory, { recursive: true }),
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

  // V2 documents ~/.config/opencode/plugins as the global auto-discovery
  // directory. The tiny wrapper keeps the canary discovery path isolated while
  // importing the repository's actual compiled adapter in place, so its normal
  // relative imports continue to resolve from dist/.
  await writeFile(
    discoveryFile,
    `export { default } from ${JSON.stringify(pathToFileURL(pluginFile).href)}\n`,
  )

  let version = ""
  let health = ""
  let plugins = ""
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

    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      pluginID,
      pluginSpecifier: pathToFileURL(pluginFile).href,
      discoveryFile,
      configScope: "isolated-global-auto-discovery",
      opencode2Version: version,
      health,
      pluginAPIContainsExpectedID: true,
      gate: true,
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
