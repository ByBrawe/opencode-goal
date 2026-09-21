import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const expectedID = "@bybrawe/opencode-goal"

function run(command, args, { cwd, env, allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
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
  const raw = String(result.stdout ?? "").trim()
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`${label} returned non-JSON output:\n${raw}\n${String(result.stderr ?? "")}`)
  }
}

function entries(value) {
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.data)) return value.data
  if (Array.isArray(value?.plugins)) return value.plugins
  return []
}

async function main() {
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-2-0-11-server-"))
  const project = path.join(temp, "project")
  const home = path.join(temp, "home")
  const config = path.join(home, ".config")
  const data = path.join(home, ".local", "share")
  const state = path.join(home, ".local", "state")
  const pluginDir = path.join(project, ".opencode", "plugins")
  const bridge = path.join(pluginDir, "opencode-goal-server.js")
  const serverFile = path.join(root, "dist", "server.js")

  await Promise.all([
    mkdir(pluginDir, { recursive: true }),
    mkdir(config, { recursive: true }),
    mkdir(data, { recursive: true }),
    mkdir(state, { recursive: true }),
  ])
  await writeFile(bridge, `export { default } from ${JSON.stringify(pathToFileURL(serverFile).href)}\n`, "utf8")
  await writeFile(path.join(project, "README.md"), "# OpenCode Goal 2.0.11 server entry canary\n", "utf8")

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    XDG_STATE_HOME: state,
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    CI: "true",
  }

  run("git", ["init", "-q"], { cwd: project, env })
  run("git", ["config", "user.name", "OpenCode Goal Canary"], { cwd: project, env })
  run("git", ["config", "user.email", "opencode-goal-canary@example.invalid"], { cwd: project, env })
  run("git", ["add", "."], { cwd: project, env })
  run("git", ["commit", "-q", "-m", "init"], { cwd: project, env })

  try {
    const version = String(run("opencode2", ["--version"], { cwd: project, env }).stdout ?? "").trim()
    if (!version.includes("2.0.11")) throw new Error(`expected OpenCode 2.0.11, got: ${version}`)

    const endpoint = `/api/plugin?location%5Bdirectory%5D=${encodeURIComponent(project)}`
    let inventory
    for (let attempt = 0; attempt < 20; attempt += 1) {
      inventory = parseJSON(run("opencode2", ["api", "get", endpoint], { cwd: project, env }), "GET /api/plugin")
      const plugin = entries(inventory).find((item) => item?.id === expectedID)
      if (plugin?.state?.status === "active") {
        console.log(JSON.stringify({ ok: true, version, plugin }, null, 2))
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }

    throw new Error(`OpenCode 2.0.11 did not activate ${expectedID}: ${JSON.stringify(inventory)}`)
  } finally {
    run("opencode2", ["service", "stop"], { cwd: project, env, allowFailure: true })
    await rm(temp, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
