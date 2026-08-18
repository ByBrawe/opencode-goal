import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"

const sentinelID = "bybrawe.opencode2-readiness-probe"
const MAX_ATTEMPTS = 20
const DELAY_MS = 500

function run(command, args, { cwd, env, allowFailure = false, timeout = 60_000 } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
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

function parseJSON(result, label) {
  const text = String(result.stdout ?? "").trim()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label} did not return JSON.\nstdout:\n${text}\nstderr:\n${String(result.stderr ?? "")}`)
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

async function markerValue(file) {
  try {
    return await readFile(file, "utf8")
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode2-plugin-readiness-"))
  const project = path.join(temp, "project")
  const home = path.join(temp, "home")
  const config = path.join(home, ".config")
  const data = path.join(home, ".local", "share")
  const state = path.join(home, ".local", "state")
  const pluginDirectory = path.join(project, ".opencode", "plugins")
  const markerFile = path.join(temp, "sentinel-loaded")

  await Promise.all([
    mkdir(pluginDirectory, { recursive: true }),
    mkdir(config, { recursive: true }),
    mkdir(data, { recursive: true }),
    mkdir(state, { recursive: true }),
  ])

  await writeFile(
    path.join(pluginDirectory, "00-readiness-sentinel.js"),
    [
      'import { writeFile } from "node:fs/promises"',
      `export default { id: ${JSON.stringify(sentinelID)}, setup: async () => {`,
      `  await writeFile(${JSON.stringify(markerFile)}, "loaded\\n", "utf8")`,
      "} }",
      "",
    ].join("\n"),
  )
  await writeFile(path.join(project, "README.md"), "# OpenCode 2 plugin readiness probe\n")
  await writeFile(path.join(project, "opencode.json"), `${JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2)}\n`)

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    XDG_STATE_HOME: state,
    OPENCODE_DB: path.join(data, "opencode", "opencode2-readiness.db"),
    OPENCODE_LOG_LEVEL: "DEBUG",
    CI: "true",
  }

  run("git", ["init", "-q"], { cwd: project, env })
  run("git", ["config", "user.name", "OpenCode Goals Probe"], { cwd: project, env })
  run("git", ["config", "user.email", "probe@example.invalid"], { cwd: project, env })
  run("git", ["add", "."], { cwd: project, env })
  run("git", ["commit", "-q", "-m", "initialize readiness probe"], { cwd: project, env })

  const attempts = []
  try {
    run("opencode2", ["service", "stop"], { cwd: project, env, allowFailure: true, timeout: 15_000 })
    const version = `${String(run("opencode2", ["--version"], { cwd: project, env, timeout: 30_000 }).stdout ?? "")}`.trim()
    const health = `${String(run("opencode2", ["api", "get", "/api/health"], { cwd: project, env }).stdout ?? "")}`.trim()
    if (!health) throw new Error("OpenCode 2 health API returned no output")

    const locationQuery = `location%5Bdirectory%5D=${encodeURIComponent(project)}`
    const pluginPath = `/api/plugin?${locationQuery}`

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const startedAt = Date.now()
      const result = run("opencode2", ["api", "get", pluginPath], { cwd: project, env })
      const response = parseJSON(result, `plugin readiness attempt ${attempt}`)
      const ids = [...new Set(collectPluginIDs(response))]
      const marker = await markerValue(markerFile)
      const ready = ids.includes(sentinelID) && marker === "loaded\n"
      attempts.push({ attempt, durationMs: Date.now() - startedAt, ids, markerWritten: marker === "loaded\n", ready })
      console.error(`readiness attempt ${attempt}/${MAX_ATTEMPTS}: ids=${JSON.stringify(ids)} marker=${marker === "loaded\n"}`)
      if (ready) {
        console.log(JSON.stringify({
          ok: true,
          opencode2Version: version,
          health,
          readyAttempt: attempt,
          elapsedRetryDelayMs: (attempt - 1) * DELAY_MS,
          attempts,
        }, null, 2))
        return
      }
      if (attempt < MAX_ATTEMPTS) await delay(DELAY_MS)
    }

    throw new Error(`OpenCode 2 project-local plugin did not become ready after ${MAX_ATTEMPTS} fresh project-scoped requests over at least ${(MAX_ATTEMPTS - 1) * DELAY_MS}ms. Attempts: ${JSON.stringify(attempts)}`)
  } finally {
    run("opencode2", ["service", "stop"], { cwd: project, env, allowFailure: true, timeout: 15_000 })
    await rm(temp, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
