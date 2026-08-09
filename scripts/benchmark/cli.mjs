import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { DEFAULT_REPEATS, expandRuns, validateManifest } from "./manifest.mjs"
import { renderMarkdown, summarize } from "./report.mjs"
import { executeRun } from "./workspace.mjs"
import { collectReportRedactions, redactValue } from "./process.mjs"
import { renderPreflightMarkdown, runPreflight } from "./preflight.mjs"

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertString(value, label) {
  assert(typeof value === "string" && value.trim(), `${label} must be a non-empty string`)
}

function parseArgs(argv) {
  const options = { manifest: "benchmarks/competitive.example.json", outDir: "benchmark-results", dryRun: false, preflight: false, keepWorkspaces: false, competitor: null, scenario: null }
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
    else if (arg === "--preflight") options.preflight = true
    else if (arg === "--keep-workspaces") options.keepWorkspaces = true
    else throw new Error(`unknown benchmark option: ${arg}`)
  }
  assertString(options.manifest, "--manifest")
  assertString(options.outDir, "--out")
  assert(!(options.preflight && options.dryRun), "--preflight and --dry-run are mutually exclusive")
  return options
}

export async function main(argv = process.argv.slice(2), root = process.cwd()) {
  const options = parseArgs(argv)
  const manifestPath = path.resolve(root, options.manifest)
  const manifestText = await readFile(manifestPath, "utf8")
  const manifestDigest = `sha256:${createHash("sha256").update(manifestText).digest("hex")}`
  const manifest = validateManifest(JSON.parse(manifestText))
  let runs = expandRuns(manifest)
  if (options.competitor) runs = runs.filter((run) => run.competitor.id === options.competitor)
  if (options.scenario) runs = runs.filter((run) => run.scenario.id === options.scenario)
  assert(runs.length > 0, "no benchmark runs selected")

  console.log(`Competitive benchmark: ${runs.length} run(s)`)
  console.log(`Manifest: ${path.relative(root, manifestPath)}`)
  if (options.preflight) {
    const preflight = await runPreflight(root, manifest, { competitorId: options.competitor, scenarioId: options.scenario })
    const outDir = path.resolve(root, options.outDir)
    await mkdir(outDir, { recursive: true })
    await writeFile(path.join(outDir, "preflight.json"), `${JSON.stringify(preflight, null, 2)}\n`)
    await writeFile(path.join(outDir, "preflight.md"), renderPreflightMarkdown(preflight))
    console.log(`Preflight: ${preflight.ok ? "PASS" : "FAIL"}`)
    console.log(`Report: ${path.relative(root, outDir).replaceAll(path.sep, "/")}/preflight.{json,md}`)
    if (!preflight.ok) process.exitCode = 1
    return preflight
  }
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

  const reportRedactions = collectReportRedactions(manifest)
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    manifest: path.relative(root, manifestPath).replaceAll(path.sep, "/"),
    manifestDigest,
    metadata: redactValue(manifest.metadata ?? {}, reportRedactions),
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
