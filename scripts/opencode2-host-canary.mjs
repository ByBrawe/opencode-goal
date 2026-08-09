import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const pluginID = "bybrawe.open-code-goals.v2-experimental"
const sentinelID = "bybrawe.open-code-goals.v2-canary-sentinel"

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
  const pluginDirectory = path.join(project, ".opencode", "plugins")
  const data = path.join(home, ".local", "share")
  const state = path.join(home, ".local", "state")
  const pluginFile = path.join(root, "dist", "opencode2", "experimental.js")
  const discoveryFile = path.join(pluginDirectory, "opencode-goals-v2-canary.js")
  const sentinelFile = path.join(pluginDirectory, "opencode-goals-v2-sentinel.js")
  const projectConfig = path.join(project, "opencode.json")
  const sentinelURL = pathToFileURL(sentinelFile).href
  const adapterURL = pathToFileURL(discoveryFile).href

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
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      plugins: [sentinelURL, adapterURL],
    }),
  }

  // Current OpenCode project detection keeps an empty `git init` workspace in
  // the global project. A repository with a real root commit receives its own
  // project ID. Use both project-root config and OPENCODE_CONFIG_CONTENT so a
  // missing plugin cannot be blamed on filesystem config discovery alone.
  run("git", ["init", "-q"], { cwd: project, env })
  await writeFile(path.join(project, "README.md"), "# OpenCode 2 canary workspace\n")
  await writeFile(
    sentinelFile,
    `export default { id: ${JSON.stringify(sentinelID)}, setup: async () => {} }\n`,
  )
  await writeFile(
    discoveryFile,
    `export { default } from ${JSON.stringify(pathToFileURL(pluginFile).href)}\n`,
  )
  await writeFile(projectConfig, `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    plugins: [
      "./.opencode/plugins/opencode-goals-v2-sentinel.js",
      "./.opencode/plugins/opencode-goals-v2-canary.js",
    ],
  }, null, 2)}\n`)
  run("git", ["config", "user.name", "OpenCode Goals Canary"], { cwd: project, env })
  run("git", ["config", "user.email", "opencode-goals-canary@example.invalid"], { cwd: project, env })
  run("git", ["add", "README.md", "opencode.json", ".opencode/plugins/opencode-goals-v2-sentinel.js", ".opencode/plugins/opencode-goals-v2-canary.js"], { cwd: project, env })
  run("git", ["commit", "-q", "-m", "initialize canary workspace"], { cwd: project, env })

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

    const pluginPath = `/api/plugin?location%5Bdirectory%5D=${encodeURIComponent(project)}`
    const pluginResult = run("opencode2", ["api", "get", pluginPath], { cwd: project, env })
    const pluginResponse = parseJSONOutput(pluginResult, "GET /api/plugin at project Location")
    if (pluginResponse?._tag) {
      throw new Error(`project-scoped /api/plugin rejected the Location: ${JSON.stringify(pluginResponse)}`)
    }
    const responseDirectory = pluginResponse?.location?.directory
    if (responseDirectory !== project) {
      throw new Error(`OpenCode 2 resolved the wrong Location: expected ${project}, got ${String(responseDirectory)}`)
    }
    if (pluginResponse?.location?.project?.id === "global") {
      throw new Error(`OpenCode 2 still classified the committed git canary workspace as global: ${JSON.stringify(pluginResponse.location)}`)
    }

    const ids = pluginIDs(pluginResponse)
    if (!ids.includes(sentinelID)) {
      throw new Error(`OpenCode 2 did not load the sentinel even when supplied through project config and OPENCODE_CONFIG_CONTENT. The exact beta host is not activating this V2 local-plugin contract. Active IDs: ${JSON.stringify(ids)}\nRaw response: ${String(pluginResult.stdout ?? "")}`)
    }
    if (!ids.includes(pluginID)) {
      throw new Error(`OpenCode 2 loaded the sentinel but not ${pluginID}; the Goals adapter module/setup is incompatible with this host. Active IDs: ${JSON.stringify(ids)}\nRaw response: ${String(pluginResult.stdout ?? "")}`)
    }

    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      pluginID,
      sentinelID,
      pluginSpecifier: pathToFileURL(pluginFile).href,
      discoveryFile,
      sentinelFile,
      configScope: "project-config-plus-opencode-config-content",
      projectLocation: project,
      projectID: pluginResponse.location.project.id,
      opencode2Version: version,
      health,
      sentinelLoaded: true,
      pluginAPIContainsExpectedID: true,
      gate: true,
    }

    console.log(`OpenCode 2 version: ${version}`)
    console.log(`health: ${health}`)
    console.log(`location: ${project}`)
    console.log(`project: ${report.projectID}`)
    console.log(`sentinel ${sentinelID}: LOADED`)
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
