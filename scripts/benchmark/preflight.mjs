import { access, cp, mkdir, mkdtemp, rm, stat } from "node:fs/promises"
import { constants as fsConstants } from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { materializeCommand, scenarioSteps } from "./manifest.mjs"
import { collectRedactions, runCommand, safeChildEnv } from "./process.mjs"
import { digestFixtureTree } from "./workspace.mjs"

const PLACEHOLDER_PATTERN = /(PIN_|EXACT_VERSION|COMPETITOR_PACKAGE|COMPETITOR_COMMAND|CHANGE_ME|REPLACE_ME)/i
const EXACT_SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

function normalizePath(value) {
  return value.split(path.sep).join("/")
}

function insideRoot(root, target) {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function isPlaceholder(value) {
  return typeof value === "string" && (PLACEHOLDER_PATTERN.test(value) || /<[^>]+>/.test(value))
}

function collectPlaceholderPaths(value, label = "metadata", out = []) {
  if (typeof value === "string") {
    if (isPlaceholder(value)) out.push(label)
    return out
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectPlaceholderPaths(item, `${label}[${index}]`, out))
    return out
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) collectPlaceholderPaths(child, `${label}.${key}`, out)
  }
  return out
}

function pluginVersion(spec) {
  if (typeof spec !== "string" || !spec.trim()) return null
  if (spec.startsWith("file:") || spec.startsWith("./") || spec.startsWith("../") || path.isAbsolute(spec)) return { local: true, version: null }
  const index = spec.lastIndexOf("@")
  if (index <= 0) return { local: false, version: null }
  return { local: false, version: spec.slice(index + 1) }
}

async function executableExists(command, env = process.env) {
  if (!command) return null
  const hasPath = path.isAbsolute(command) || command.includes("/") || command.includes("\\")
  const candidates = []
  if (hasPath) {
    candidates.push(command)
  } else {
    const pathValue = env.PATH ?? ""
    const extensions = process.platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""]
    for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
      if (process.platform === "win32" && path.extname(command)) candidates.push(path.join(directory, command))
      else for (const extension of extensions) candidates.push(path.join(directory, `${command}${extension}`))
    }
  }
  for (const candidate of candidates) {
    try {
      await access(candidate, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK)
      return candidate
    } catch {}
  }
  return null
}

function addCheck(checks, status, id, message, details = undefined) {
  checks.push({ status, id, message, ...(details === undefined ? {} : { details }) })
}

async function checkCommandExecutable(checks, id, command) {
  if (!command) return
  if (command.some(isPlaceholder)) {
    addCheck(checks, "error", id, "command still contains placeholder values")
    return
  }
  const resolved = await executableExists(command[0])
  if (resolved) addCheck(checks, "pass", id, `${command[0]} is executable`, normalizePath(resolved))
  else addCheck(checks, "error", id, `${command[0]} was not found on PATH`)
}

async function preflightScenarioOracle(root, manifest, scenario, checks) {
  if (!scenario.preflightOracle || scenario.preflightOracle === "skip") return
  const source = path.resolve(root, scenario.workspace)
  const temp = await mkdtemp(path.join(os.tmpdir(), `opencode-goal-preflight-${scenario.id.replace(/[^a-zA-Z0-9._-]+/g, "-")}-`))
  const workspace = path.join(temp, "workspace")
  const home = path.join(temp, "home")
  try {
    await mkdir(home, { recursive: true })
    await cp(source, workspace, { recursive: true, dereference: false, errorOnExist: false })
    const steps = scenarioSteps(scenario)
    const variables = {
      root,
      workspace,
      home,
      prompt: steps.at(-1)?.prompt ?? "",
      competitor: "preflight",
      scenario: scenario.id,
      run: "0",
      step: "preflight",
    }
    const env = safeChildEnv({ home, passEnv: manifest.passEnv ?? [], extra: manifest.env ?? {} })
    const redactions = collectRedactions(manifest, { env: {} }, env)
    const result = await runCommand(materializeCommand(scenario.oracle.command, variables), {
      cwd: workspace,
      env,
      timeoutMs: Math.min(scenario.oracle.timeoutMs ?? scenario.timeoutMs ?? manifest.timeoutMs ?? 30_000, 30_000),
      redactions,
    })
    if (result.spawnError || result.timedOut) {
      addCheck(checks, "error", `scenario:${scenario.id}:oracle-baseline`, "baseline oracle could not run cleanly", { spawnError: result.spawnError, timedOut: result.timedOut })
      return
    }
    const actual = result.exitCode === 0 ? "pass" : "fail"
    if (actual === scenario.preflightOracle) {
      addCheck(checks, "pass", `scenario:${scenario.id}:oracle-baseline`, `baseline oracle correctly starts ${actual.toUpperCase()}`)
    } else {
      addCheck(checks, "error", `scenario:${scenario.id}:oracle-baseline`, `baseline oracle expected ${scenario.preflightOracle.toUpperCase()} but started ${actual.toUpperCase()}`, {
        exitCode: result.exitCode,
        stderr: result.stderr.slice(-1000),
        stdout: result.stdout.slice(-1000),
      })
    }
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

export async function runPreflight(root, manifest, selection = {}) {
  const checks = []
  const fixtureDigests = {}
  const placeholders = collectPlaceholderPaths(manifest.metadata ?? {})
  if (placeholders.length) addCheck(checks, "error", "metadata:placeholders", "reproducibility metadata still contains placeholder values", placeholders)
  else addCheck(checks, "pass", "metadata:placeholders", "reproducibility metadata contains no known placeholders")

  for (const name of manifest.requiredEnv ?? []) {
    if (typeof process.env[name] === "string" && process.env[name].length > 0) addCheck(checks, "pass", `env:${name}`, `${name} is present`)
    else addCheck(checks, "error", `env:${name}`, `${name} is required but missing`)
  }

  const competitors = manifest.competitors.filter((item) => !selection.competitorId || item.id === selection.competitorId)
  const scenarios = manifest.scenarios.filter((item) => !selection.scenarioId || item.id === selection.scenarioId)

  for (const competitor of competitors) {
    await checkCommandExecutable(checks, `competitor:${competitor.id}:command`, competitor.command)
    await checkCommandExecutable(checks, `competitor:${competitor.id}:setup`, competitor.setup?.command)

    const plugins = competitor.opencodeConfig?.plugin
    if (plugins !== undefined && !Array.isArray(plugins)) {
      addCheck(checks, "error", `competitor:${competitor.id}:plugins`, "opencodeConfig.plugin must be an array for preflight pin checks")
      continue
    }
    for (const spec of plugins ?? []) {
      if (isPlaceholder(spec)) {
        addCheck(checks, "error", `competitor:${competitor.id}:plugin:${spec}`, "plugin spec still contains placeholder values")
        continue
      }
      const parsed = pluginVersion(spec)
      if (parsed?.local) addCheck(checks, "warn", `competitor:${competitor.id}:plugin:${spec}`, "local plugin path is not content-pinned; record its commit/tree digest separately")
      else if (!parsed?.version || !EXACT_SEMVER_PATTERN.test(parsed.version)) addCheck(checks, "error", `competitor:${competitor.id}:plugin:${spec}`, "plugin must use an exact npm semver, not latest/next/range/unversioned")
      else addCheck(checks, "pass", `competitor:${competitor.id}:plugin:${spec}`, `plugin is pinned to exact version ${parsed.version}`)
    }
  }

  for (const scenario of scenarios) {
    await checkCommandExecutable(checks, `scenario:${scenario.id}:setup`, scenario.setup?.command)
    await checkCommandExecutable(checks, `scenario:${scenario.id}:oracle`, scenario.oracle?.command)
    for (const step of scenarioSteps(scenario)) {
      await checkCommandExecutable(checks, `scenario:${scenario.id}:step:${step.id}:oracle`, step.oracle?.command)
    }

    const source = path.resolve(root, scenario.workspace)
    if (!insideRoot(root, source)) {
      addCheck(checks, "error", `scenario:${scenario.id}:workspace`, "scenario workspace escapes benchmark root")
      continue
    }
    try {
      const info = await stat(source)
      if (!info.isDirectory()) throw new Error("not a directory")
      const digest = await digestFixtureTree(source)
      fixtureDigests[scenario.id] = digest
      addCheck(checks, "pass", `scenario:${scenario.id}:workspace`, "fixture exists and was hashed", digest)
      await preflightScenarioOracle(root, manifest, scenario, checks)
    } catch (error) {
      addCheck(checks, "error", `scenario:${scenario.id}:workspace`, `fixture is unavailable: ${error?.message ?? error}`)
    }
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    ok: !checks.some((item) => item.status === "error"),
    selection: { competitor: selection.competitorId ?? null, scenario: selection.scenarioId ?? null },
    fixtureDigests,
    checks,
  }
}

export function renderPreflightMarkdown(report) {
  const lines = [
    "# Competitive Benchmark Preflight", "",
    `Generated: ${report.generatedAt}`,
    `Gate: **${report.ok ? "PASS" : "FAIL"}**`, "",
    "| Status | Check | Result |",
    "|---|---|---|",
  ]
  for (const check of report.checks) {
    const detail = check.details === undefined ? "" : ` — ${typeof check.details === "string" ? check.details : JSON.stringify(check.details)}`
    lines.push(`| ${check.status.toUpperCase()} | \`${check.id}\` | ${(check.message + detail).replaceAll("|", "\\|")} |`)
  }
  lines.push("", "Preflight never invokes a model. It verifies benchmark wiring, pinned inputs, required environment, fixture hashes, command executables, and declared baseline oracle state.", "")
  return `${lines.join("\n")}\n`
}
