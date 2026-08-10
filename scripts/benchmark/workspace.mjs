import { createHash } from "node:crypto"
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DEFAULT_TIMEOUT_MS, materializeCommand, scenarioSteps } from "./manifest.mjs"
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

function oracleActual(result) {
  if (!result || result.spawnError || result.timedOut) return null
  return result.exitCode === 0 ? "pass" : "fail"
}

export async function executeRun(root, manifest, spec, keepWorkspaces) {
  const { competitor, scenario, repeat } = spec
  const runKey = `${competitor.id}-${scenario.id}-${repeat}`.replace(/[^a-zA-Z0-9._-]+/g, "-")
  const { runRoot, workspace, home, fixtureDigest } = await prepareWorkspace(root, scenario, runKey)
  const steps = scenarioSteps(scenario)
  const seedPrompt = steps[0]?.prompt ?? ""
  const timeoutMs = scenario.timeoutMs ?? manifest.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const baseVariables = { root, workspace, home, prompt: seedPrompt, competitor: competitor.id, scenario: scenario.id, run: String(repeat), step: "setup" }
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
  const agentSteps = []
  const stepOracles = []
  let stepFailure = null
  let infrastructureFailure = false
  try {
    if (competitor.setup?.command) {
      competitorSetup = await runCommand(materializeCommand(competitor.setup.command, baseVariables), runOptions(competitor.setup.timeoutMs ?? timeoutMs))
      if (commandFailed(competitorSetup)) infrastructureFailure = true
    }
    if (!infrastructureFailure && scenario.setup?.command) {
      setup = await runCommand(materializeCommand(scenario.setup.command, baseVariables), runOptions(scenario.setup.timeoutMs ?? timeoutMs))
      if (commandFailed(setup)) infrastructureFailure = true
    }

    if (!infrastructureFailure) {
      for (const [index, step] of steps.entries()) {
        const variables = { ...baseVariables, prompt: step.prompt, step: step.id }
        const stepAgent = await runCommand(materializeCommand(competitor.command, variables), runOptions(step.timeoutMs ?? timeoutMs))
        agent = stepAgent
        agentSteps.push({ id: step.id, index, agent: stepAgent })
        if (stepAgent.spawnError) {
          infrastructureFailure = true
          break
        }

        if (step.oracle) {
          const stepOracle = await runCommand(
            materializeCommand(step.oracle.command, variables),
            runOptions(step.oracle.timeoutMs ?? step.timeoutMs ?? timeoutMs),
          )
          const expected = step.oracle.expect ?? "pass"
          const actual = oracleActual(stepOracle)
          const matched = actual !== null && actual === expected
          stepOracles.push({ id: step.id, index, expected, actual, matched, oracle: stepOracle })
          if (stepOracle.spawnError || stepOracle.timedOut) {
            infrastructureFailure = true
            break
          }
          if (!matched) {
            stepFailure = { id: step.id, index, expected, actual }
            break
          }
        }
      }
    }

    if (!infrastructureFailure) {
      const finalVariables = { ...baseVariables, prompt: steps.at(-1)?.prompt ?? seedPrompt, step: "final" }
      oracle = await runCommand(
        materializeCommand(scenario.oracle.command, finalVariables),
        runOptions(scenario.oracle.timeoutMs ?? timeoutMs),
      )
    }
    const passed = !infrastructureFailure && !stepFailure && oracle?.exitCode === 0 && !oracle?.timedOut && !oracle?.spawnError
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
      agentSteps,
      stepOracles,
      stepFailure,
      oracle,
    }
  } finally {
    if (!keepWorkspaces) await rm(runRoot, { recursive: true, force: true })
  }
}
