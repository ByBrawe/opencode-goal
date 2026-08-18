import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const expectedDescription = "Manage a persistent OpenCode Goal (experimental OpenCode 2 adapter)."
const expectedPreamble = "OpenCode Goals V2 command wrapper. The text after the capability marker is raw user command data."
const capabilityPattern = /__OPENCODE_GOALS_V2_COMMAND_[0-9a-f-]+__/i

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

function requireGoalCommand(response, project, label) {
  if (response?._tag) throw new Error(`${label} rejected the project Location: ${JSON.stringify(response)}`)
  if (response?.location?.directory !== project) {
    throw new Error(`${label} resolved the wrong Location: expected ${project}, got ${String(response?.location?.directory)}`)
  }
  if (response?.location?.project?.id === "global") {
    throw new Error(`${label} classified the committed git canary workspace as global: ${JSON.stringify(response.location)}`)
  }
  if (!Array.isArray(response?.data)) {
    throw new Error(`${label} did not return a command array: ${JSON.stringify(response)}`)
  }

  const goals = response.data.filter((command) => command?.name === "goal")
  if (goals.length !== 1) {
    throw new Error(`${label} expected exactly one goal command, found ${goals.length}: ${JSON.stringify(response.data)}`)
  }
  const goal = goals[0]
  if (goal.description !== expectedDescription) {
    throw new Error(`${label} goal description mismatch: ${JSON.stringify(goal)}`)
  }
  if (goal.subtask !== false) {
    throw new Error(`${label} goal command must set subtask=false: ${JSON.stringify(goal)}`)
  }
  if (typeof goal.template !== "string" || !goal.template.startsWith(expectedPreamble)) {
    throw new Error(`${label} goal template did not contain the experimental wrapper preamble: ${JSON.stringify(goal)}`)
  }
  const marker = goal.template.match(capabilityPattern)?.[0]
  if (!marker) {
    throw new Error(`${label} goal template did not contain a request capability marker: ${JSON.stringify(goal)}`)
  }
  if (!goal.template.endsWith("\n$ARGUMENTS")) {
    throw new Error(`${label} goal template did not preserve raw command arguments at the end: ${JSON.stringify(goal)}`)
  }
  return { goal, marker }
}

async function main() {
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-v2-command-host-"))
  const project = path.join(temp, "project")
  const home = path.join(temp, "home")
  const config = path.join(home, ".config")
  const data = path.join(home, ".local", "share")
  const state = path.join(home, ".local", "state")
  const pluginDirectory = path.join(project, ".opencode", "plugins")
  const pluginFile = path.join(root, "dist", "opencode2", "experimental.js")
  const adapterBridge = path.join(pluginDirectory, "opencode-goals-v2-command-canary.js")

  await Promise.all([
    mkdir(pluginDirectory, { recursive: true }),
    mkdir(config, { recursive: true }),
    mkdir(data, { recursive: true }),
    mkdir(state, { recursive: true }),
  ])

  await writeFile(adapterBridge, `export { default } from ${JSON.stringify(pathToFileURL(pluginFile).href)}\n`)
  await writeFile(path.join(project, "README.md"), "# OpenCode 2 command registry canary\n")
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
    OPENCODE_DB: path.join(data, "opencode", "opencode-v2-command-canary.db"),
    OPENCODE_LOG_LEVEL: "DEBUG",
    CI: "true",
  }

  run("git", ["init", "-q"], { cwd: project, env })
  run("git", ["config", "user.name", "OpenCode Goals Canary"], { cwd: project, env })
  run("git", ["config", "user.email", "opencode-goals-canary@example.invalid"], { cwd: project, env })
  run("git", ["add", "."], { cwd: project, env })
  run("git", ["commit", "-q", "-m", "initialize command canary workspace"], { cwd: project, env })

  try {
    run("opencode2", ["service", "stop"], { cwd: project, env, allowFailure: true, timeout: 15_000 })
    const version = output(run("opencode2", ["--version"], { cwd: project, env, timeout: 30_000 }))
    if (!version) throw new Error("opencode2 --version returned no output")

    const commandPath = `/api/command?location%5Bdirectory%5D=${encodeURIComponent(project)}`
    const firstResult = run("opencode2", ["api", "get", commandPath], { cwd: project, env })
    const firstResponse = parseJSONOutput(firstResult, "first GET /api/command at project Location")
    const first = requireGoalCommand(firstResponse, project, "first GET /api/command")

    const secondResult = run("opencode2", ["api", "get", commandPath], { cwd: project, env })
    const secondResponse = parseJSONOutput(secondResult, "second GET /api/command at project Location")
    const second = requireGoalCommand(secondResponse, project, "second GET /api/command")

    if (second.goal.template !== first.goal.template || second.marker !== first.marker) {
      throw new Error("OpenCode 2 re-ran or destabilized the Goal command transform between reads in one plugin host instance.")
    }

    console.log(JSON.stringify({
      ok: true,
      platform: process.platform,
      node: process.version,
      opencode2Version: version,
      projectDirectory: firstResponse.location.directory,
      projectID: firstResponse.location.project.id,
      commandName: first.goal.name,
      commandDescription: first.goal.description,
      subtask: first.goal.subtask,
      capabilityMarkerStableAcrossReads: true,
      rawArgumentsPlaceholderPresent: first.goal.template.endsWith("\n$ARGUMENTS"),
    }, null, 2))
  } finally {
    run("opencode2", ["service", "stop"], { cwd: project, env, allowFailure: true, timeout: 15_000 })
    await rm(temp, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
