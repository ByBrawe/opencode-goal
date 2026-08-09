import { createHash } from "node:crypto"
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DEFAULT_TIMEOUT_MS, materializeCommand } from "./manifest.mjs"
import { collectRedactions, runCommand, safeChildEnv } from "./process.mjs"

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

export async function digestFixtureTree(root) {
  const hash = createHash("sha256")
  async function walk(relative) {
    const absolute = path.join(root, relative)
    const stat = await lstat(absolute)
    const normalized = relative.split(path.sep).join("/")
    hash.update(`${normalized}\0${stat.mode & 0o777}\0`)
    if (stat.isSymbolicLink()) {
      hash.update("L\0")
      hash.update(await readlink(absolute))
      hash.update("\0")
      return
    }
    if (stat.isDirectory()) {
      hash.update("D\0")
      for (const entry of (await readdir(absolute)).sort()) await walk(path.join(relative, entry))
      return
    }
    if (stat.isFile()) {
      hash.update("F\0")
      hash.update(await readFile(absolute))
      hash.update("\0")
      return
    }
    hash.update("O\0")
  }
  await walk("")
  return `sha256:${hash.digest("hex")}`
}

async function writeCompetitorConfig(home, competitor) {
  if (!competitor.opencodeConfig) return null
  const configDir = path.join(home, ".config", "opencode")
  const configPath = path.join(configDir, "opencode.json")
  await mkdir(configDir, { recursive: true })
  await writeFile(configPath, `${JSON.stringify(competitor.opencodeConfig, null, 2)}\n`)
  return configPath
}

async function prepareWorkspace(root, scenario, runKey) {
  const source = path.resolve(root, scenario.workspace)
  const relative = path.relative(root, source)
  assert(relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative), `scenario ${scenario.id}.workspace must stay inside the benchmark root`)
  const fixtureDigest = await digestFixtureTree(source)
  const runRoot = await mkdtemp(path.join(os.tmpdir(), `opencode-goal-bench-${runKey}-`))
  const workspace = path.join(runRoot, "workspace")
  const home = path.join(runRoot, "home")
  await mkdir(home, { recursive: true })
  await cp(source, workspace, { recursive: true, dereference: false, errorOnExist: false })
  return { runRoot, workspace, home, fixtureDigest }
}

function commandFailed(result) {
  return !result || result.exitCode !== 0 || result.timedOut || Boolean(result.spawnError)
}

export async function executeRun(root, manifest, spec, keepWorkspaces) {
  const { competitor, scenario, repeat } = spec
  const runKey = `${competitor.id}-${scenario.id}-${repeat}`.replace(/[^a-zA-Z0-9._-]+/g, "-")
  const { runRoot, workspace, home, fixtureDigest } = await prepareWorkspace(root, scenario, runKey)
  const variables = { root, workspace, home, prompt: scenario.prompt, competitor: competitor.id, scenario: scenario.id, run: String(repeat) }
  const timeoutMs = scenario.timeoutMs ?? manifest.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const env = safeChildEnv({
    home,
    passEnv: manifest.passEnv ?? [],
    extra: {
      ...(manifest.env ?? {}),
      ...(competitor.env ?? {}),
      OPENCODE_GOAL_BENCHMARK: "1",
      OPENCODE_GOAL_BENCHMARK_COMPETITOR: competitor.id,
      OPENCODE_GOAL_BENCHMARK_SCENARIO: scenario.id,
      OPENCODE_GOAL_BENCHMARK_RUN: String(repeat),
    },
  })
  const redactions = collectRedactions(manifest, competitor, env)
  await writeCompetitorConfig(home, competitor)
  const runOptions = (phaseTimeoutMs = timeoutMs) => ({ cwd: workspace, env, timeoutMs: phaseTimeoutMs, redactions })

  let competitorSetup = null
  let setup = null
  let agent = null
  let oracle = null
  let infrastructureFailure = false
  try {
    if (competitor.setup?.command) {
      competitorSetup = await runCommand(materializeCommand(competitor.setup.command, variables), runOptions(competitor.setup.timeoutMs ?? timeoutMs))
      if (commandFailed(competitorSetup)) infrastructureFailure = true
    }
    if (!infrastructureFailure && scenario.setup?.command) {
      setup = await runCommand(materializeCommand(scenario.setup.command, variables), runOptions(scenario.setup.timeoutMs ?? timeoutMs))
      if (commandFailed(setup)) infrastructureFailure = true
    }
    if (!infrastructureFailure) {
      agent = await runCommand(materializeCommand(competitor.command, variables), runOptions())
      if (agent.spawnError) infrastructureFailure = true
    }
    if (!infrastructureFailure) oracle = await runCommand(materializeCommand(scenario.oracle.command, variables), runOptions())
    const passed = !infrastructureFailure && oracle?.exitCode === 0 && !oracle?.timedOut && !oracle?.spawnError
    return {
      competitor: competitor.id,
      competitorLabel: competitor.label ?? competitor.id,
      scenario: scenario.id,
      category: scenario.category,
      weight: scenario.weight,
      repeat,
      fixtureDigest,
      passed,
      infrastructureFailure,
      runRoot: keepWorkspaces ? runRoot : null,
      competitorSetup,
      setup,
      agent,
      oracle,
    }
  } finally {
    if (!keepWorkspaces) await rm(runRoot, { recursive: true, force: true })
  }
}
