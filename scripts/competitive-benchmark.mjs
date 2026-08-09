import { spawnSync } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { pathToFileURL } from "node:url"

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_REPEATS = 3
const BASE_ENV_KEYS = process.platform === "win32"
  ? ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP"]
  : ["PATH", "LANG", "LC_ALL", "TERM", "TMPDIR"]

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertString(value, label) {
  assert(typeof value === "string" && value.trim(), `${label} must be a non-empty string`)
}

function validateCommand(command, label) {
  assert(Array.isArray(command) && command.length > 0, `${label} must be a non-empty argv array`)
  command.forEach((part, index) => assertString(part, `${label}[${index}]`))
}

export function validateManifest(manifest) {
  assert(manifest?.schemaVersion === 1, "manifest.schemaVersion must be 1")
  assert(Array.isArray(manifest.competitors) && manifest.competitors.length > 0, "manifest.competitors must be non-empty")
  assert(Array.isArray(manifest.scenarios) && manifest.scenarios.length > 0, "manifest.scenarios must be non-empty")
  if (manifest.repeats !== undefined) assert(Number.isInteger(manifest.repeats) && manifest.repeats > 0, "manifest.repeats must be a positive integer")
  if (manifest.timeoutMs !== undefined) assert(Number.isInteger(manifest.timeoutMs) && manifest.timeoutMs > 0, "manifest.timeoutMs must be a positive integer")
  if (manifest.passEnv !== undefined) {
    assert(Array.isArray(manifest.passEnv), "manifest.passEnv must be an array")
    manifest.passEnv.forEach((name, index) => assertString(name, `manifest.passEnv[${index}]`))
  }

  const competitorIds = new Set()
  for (const competitor of manifest.competitors) {
    assertString(competitor?.id, "competitor.id")
    assert(!competitorIds.has(competitor.id), `duplicate competitor id: ${competitor.id}`)
    competitorIds.add(competitor.id)
    validateCommand(competitor.command, `competitor ${competitor.id}.command`)
    if (competitor.label !== undefined) assertString(competitor.label, `competitor ${competitor.id}.label`)
    if (competitor.env !== undefined) {
      assert(competitor.env && typeof competitor.env === "object" && !Array.isArray(competitor.env), `competitor ${competitor.id}.env must be an object`)
      for (const [key, value] of Object.entries(competitor.env)) {
        assertString(key, `competitor ${competitor.id}.env key`)
        assert(typeof value === "string", `competitor ${competitor.id}.env.${key} must be a string`)
      }
    }
  }

  const scenarioIds = new Set()
  for (const scenario of manifest.scenarios) {
    assertString(scenario?.id, "scenario.id")
    assert(!scenarioIds.has(scenario.id), `duplicate scenario id: ${scenario.id}`)
    scenarioIds.add(scenario.id)
    assertString(scenario.category, `scenario ${scenario.id}.category`)
    assertString(scenario.workspace, `scenario ${scenario.id}.workspace`)
    assertString(scenario.prompt, `scenario ${scenario.id}.prompt`)
    assert(Number.isFinite(scenario.weight) && scenario.weight > 0, `scenario ${scenario.id}.weight must be > 0`)
    validateCommand(scenario.oracle?.command, `scenario ${scenario.id}.oracle.command`)
    if (scenario.setup?.command) validateCommand(scenario.setup.command, `scenario ${scenario.id}.setup.command`)
    if (scenario.timeoutMs !== undefined) assert(Number.isInteger(scenario.timeoutMs) && scenario.timeoutMs > 0, `scenario ${scenario.id}.timeoutMs must be a positive integer`)
  }
  return manifest
}

export function expandRuns(manifest) {
  const repeats = manifest.repeats ?? DEFAULT_REPEATS
  const runs = []
  for (const competitor of manifest.competitors) {
    for (const scenario of manifest.scenarios) {
      for (let repeat = 1; repeat <= repeats; repeat += 1) runs.push({ competitor, scenario, repeat })
    }
  }
  return runs
}

function replaceTemplate(value, variables) {
  return value.replace(/\{(workspace|prompt|competitor|scenario|run)\}/g, (_, key) => variables[key])
}

export function materializeCommand(command, variables) {
  return command.map((part) => replaceTemplate(part, variables))
}

function safeChildEnv({ home, passEnv = [], extra = {} }) {
  const env = {}
  for (const key of BASE_ENV_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key]
  env.HOME = home
  if (process.platform === "win32") env.USERPROFILE = home
  env.XDG_CONFIG_HOME = path.join(home, ".config")
  env.XDG_DATA_HOME = path.join(home, ".local", "share")
  env.XDG_STATE_HOME = path.join(home, ".local", "state")
  env.FORCE_COLOR = "0"
  env.NO_COLOR = "1"
  env.CI = "1"
  for (const key of passEnv) if (process.env[key] !== undefined) env[key] = process.env[key]
  for (const [key, value] of Object.entries(extra)) env[key] = String(value)
  return env
}

function runCommand(command, options) {
  const started = performance.now()
  const child = spawnSync(command[0], command.slice(1), {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    timeout: options.timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
  })
  return {
    command,
    exitCode: child.status,
    signal: child.signal,
    timedOut: child.error?.code === "ETIMEDOUT",
    durationMs: Math.round(performance.now() - started),
    stdout: String(child.stdout ?? "").slice(-20000),
    stderr: String(child.stderr ?? "").slice(-20000),
    spawnError: child.error ? String(child.error.message ?? child.error) : null,
  }
}

async function prepareWorkspace(root, scenario, runKey) {
  const source = path.resolve(root, scenario.workspace)
  const runRoot = await mkdtemp(path.join(os.tmpdir(), `opencode-goal-bench-${runKey}-`))
  const workspace = path.join(runRoot, "workspace")
  const home = path.join(runRoot, "home")
  await mkdir(home, { recursive: true })
  await cp(source, workspace, { recursive: true, dereference: false, errorOnExist: false })
  return { runRoot, workspace, home }
}

async function executeRun(root, manifest, spec, keepWorkspaces) {
  const { competitor, scenario, repeat } = spec
  const runKey = `${competitor.id}-${scenario.id}-${repeat}`.replace(/[^a-zA-Z0-9._-]+/g, "-")
  const { runRoot, workspace, home } = await prepareWorkspace(root, scenario, runKey)
  const variables = { workspace, prompt: scenario.prompt, competitor: competitor.id, scenario: scenario.id, run: String(repeat) }
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

  let setup = null
  let agent = null
  let oracle = null
  let infrastructureFailure = false
  try {
    if (scenario.setup?.command) {
      setup = runCommand(materializeCommand(scenario.setup.command, variables), { cwd: workspace, env, timeoutMs })
      if (setup.exitCode !== 0 || setup.timedOut || setup.spawnError) infrastructureFailure = true
    }
    if (!infrastructureFailure) {
      agent = runCommand(materializeCommand(competitor.command, variables), { cwd: workspace, env, timeoutMs })
      oracle = runCommand(materializeCommand(scenario.oracle.command, variables), { cwd: workspace, env, timeoutMs })
    }
    const passed = !infrastructureFailure && oracle?.exitCode === 0 && !oracle?.timedOut && !oracle?.spawnError
    return {
      competitor: competitor.id,
      competitorLabel: competitor.label ?? competitor.id,
      scenario: scenario.id,
      category: scenario.category,
      weight: scenario.weight,
      repeat,
      passed,
      infrastructureFailure,
      runRoot: keepWorkspaces ? runRoot : null,
      setup,
      agent,
      oracle,
    }
  } finally {
    if (!keepWorkspaces) await rm(runRoot, { recursive: true, force: true })
  }
}

export function summarize(results) {
  const competitors = new Map()
  for (const result of results) {
    let row = competitors.get(result.competitor)
    if (!row) {
      row = { id: result.competitor, label: result.competitorLabel, runs: 0, passed: 0, weightedPassed: 0, weightedTotal: 0, categories: new Map() }
      competitors.set(result.competitor, row)
    }
    row.runs += 1
    row.passed += result.passed ? 1 : 0
    row.weightedTotal += result.weight
    row.weightedPassed += result.passed ? result.weight : 0
    let category = row.categories.get(result.category)
    if (!category) {
      category = { category: result.category, runs: 0, passed: 0, weightedPassed: 0, weightedTotal: 0 }
      row.categories.set(result.category, category)
    }
    category.runs += 1
    category.passed += result.passed ? 1 : 0
    category.weightedTotal += result.weight
    category.weightedPassed += result.passed ? result.weight : 0
  }
  return [...competitors.values()].map((row) => ({
    id: row.id,
    label: row.label,
    runs: row.runs,
    passed: row.passed,
    passRate: row.runs ? row.passed / row.runs : 0,
    weightedScore: row.weightedTotal ? row.weightedPassed / row.weightedTotal : 0,
    weightedPassed: row.weightedPassed,
    weightedTotal: row.weightedTotal,
    categories: [...row.categories.values()].map((category) => ({
      ...category,
      passRate: category.runs ? category.passed / category.runs : 0,
      weightedScore: category.weightedTotal ? category.weightedPassed / category.weightedTotal : 0,
    })).sort((a, b) => a.category.localeCompare(b.category)),
  })).sort((a, b) => b.weightedScore - a.weightedScore || b.passRate - a.passRate || a.id.localeCompare(b.id))
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`
}

export function renderMarkdown(report) {
  const lines = [
    "# Competitive Benchmark Report", "",
    `Generated: ${report.generatedAt}`,
    `Manifest: \`${report.manifest}\``,
    `Runs: ${report.results.length}`, "",
    "## Ranking", "",
    "| Rank | Competitor | Weighted score | Pass rate | Runs |",
    "|---:|---|---:|---:|---:|",
  ]
  report.summary.forEach((row, index) => lines.push(`| ${index + 1} | ${row.label} (\`${row.id}\`) | ${pct(row.weightedScore)} | ${pct(row.passRate)} | ${row.passed}/${row.runs} |`))
  for (const row of report.summary) {
    lines.push("", `## ${row.label}`, "", "| Category | Weighted score | Pass rate |", "|---|---:|---:|")
    for (const category of row.categories) lines.push(`| ${category.category} | ${pct(category.weightedScore)} | ${category.passed}/${category.runs} (${pct(category.passRate)}) |`)
    const failures = report.results.filter((item) => item.competitor === row.id && !item.passed)
    lines.push("", "### Failures", "")
    if (!failures.length) lines.push("None.")
    for (const failure of failures) lines.push(`- \`${failure.scenario}\` run ${failure.repeat}: ${failure.infrastructureFailure ? "infrastructure failure" : `oracle exit ${failure.oracle?.exitCode ?? "n/a"}`}; agent exit ${failure.agent?.exitCode ?? "n/a"}${failure.agent?.timedOut ? " (timeout)" : ""}`)
  }
  lines.push("", "## Interpretation", "", "A run passes only when the scenario oracle exits 0. Agent narration and the agent process exit code do not prove task success.", "")
  return `${lines.join("\n")}\n`
}

function parseArgs(argv) {
  const options = { manifest: "benchmarks/competitive.example.json", outDir: "benchmark-results", dryRun: false, keepWorkspaces: false, competitor: null, scenario: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--manifest") options.manifest = argv[++i]
    else if (arg.startsWith("--manifest=")) options.manifest = arg.slice(11)
    else if (arg === "--out") options.outDir = argv[++i]
    else if (arg.startsWith("--out=")) options.outDir = arg.slice(6)
    else if (arg === "--competitor") options.competitor = argv[++i]
    else if (arg.startsWith("--competitor=")) options.competitor = arg.slice(13)
    else if (arg === "--scenario") options.scenario = argv[++i]
    else if (arg.startsWith("--scenario=")) options.scenario = arg.slice(11)
    else if (arg === "--dry-run") options.dryRun = true
    else if (arg === "--keep-workspaces") options.keepWorkspaces = true
    else throw new Error(`unknown benchmark option: ${arg}`)
  }
  assertString(options.manifest, "--manifest")
  assertString(options.outDir, "--out")
  return options
}

async function main() {
  const root = process.cwd()
  const options = parseArgs(process.argv.slice(2))
  const manifestPath = path.resolve(root, options.manifest)
  const manifest = validateManifest(JSON.parse(await readFile(manifestPath, "utf8")))
  let runs = expandRuns(manifest)
  if (options.competitor) runs = runs.filter((run) => run.competitor.id === options.competitor)
  if (options.scenario) runs = runs.filter((run) => run.scenario.id === options.scenario)
  assert(runs.length > 0, "no benchmark runs selected")

  console.log(`Competitive benchmark: ${runs.length} run(s)`)
  console.log(`Manifest: ${path.relative(root, manifestPath)}`)
  if (options.dryRun) {
    for (const run of runs) console.log(`${run.competitor.id} :: ${run.scenario.id} :: run ${run.repeat}`)
    return
  }

  const results = []
  for (const [index, spec] of runs.entries()) {
    process.stdout.write(`[${index + 1}/${runs.length}] ${spec.competitor.id} :: ${spec.scenario.id} :: ${spec.repeat} ... `)
    const result = await executeRun(root, manifest, spec, options.keepWorkspaces)
    results.push(result)
    console.log(result.passed ? "PASS" : "FAIL")
  }

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    manifest: path.relative(root, manifestPath).replaceAll(path.sep, "/"),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    repeats: manifest.repeats ?? DEFAULT_REPEATS,
    results,
    summary: summarize(results),
  }
  const outDir = path.resolve(root, options.outDir)
  await mkdir(outDir, { recursive: true })
  await writeFile(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`)
  await writeFile(path.join(outDir, "report.md"), renderMarkdown(report))
  console.log(`Report: ${path.relative(root, outDir).replaceAll(path.sep, "/")}/report.{json,md}`)
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null
if (invoked === import.meta.url) {
  main().catch((error) => {
    console.error(error?.stack || error)
    process.exitCode = 1
  })
}
