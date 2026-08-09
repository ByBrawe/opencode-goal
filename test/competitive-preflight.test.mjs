import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { validateManifest } from "../scripts/benchmark/manifest.mjs"
import { runPreflight } from "../scripts/benchmark/preflight.mjs"
import { main as benchmarkMain } from "../scripts/benchmark/cli.mjs"
import os from "node:os"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function baseManifest() {
  return {
    schemaVersion: 1,
    repeats: 1,
    metadata: { opencodeVersion: "1.2.3", model: "provider/model", provider: "provider" },
    competitors: [{ id: "node", command: [process.execPath, "-e", "void 0"] }],
    scenarios: [{
      id: "normal-completion",
      category: "correctness",
      weight: 1,
      workspace: "benchmarks/fixtures/normal-completion",
      prompt: "fix it",
      preflightOracle: "fail",
      oracle: { command: [process.execPath, "{root}/benchmarks/oracles/normal-completion.mjs", "{workspace}"] },
    }],
  }
}

test("preflight passes a pinned local wiring with the declared red baseline oracle", async () => {
  const manifest = validateManifest(baseManifest())
  const report = await runPreflight(root, manifest)
  assert.equal(report.ok, true)
  assert.match(report.fixtureDigests["normal-completion"], /^sha256:[a-f0-9]{64}$/)
  assert.ok(report.checks.some((item) => item.id.endsWith(":oracle-baseline") && item.status === "pass"))
})

test("preflight rejects missing required environment without exposing values", async () => {
  const name = "OPENCODE_GOAL_BENCHMARK_TEST_MISSING_ENV"
  delete process.env[name]
  const manifest = validateManifest({ ...baseManifest(), passEnv: [name], requiredEnv: [name] })
  const report = await runPreflight(root, manifest)
  assert.equal(report.ok, false)
  const check = report.checks.find((item) => item.id === `env:${name}`)
  assert.equal(check.status, "error")
  assert.doesNotMatch(JSON.stringify(report), /super-secret-value/)
})

test("preflight rejects moving npm plugin tags and accepts exact semver pins", async () => {
  const moving = baseManifest()
  moving.competitors[0].opencodeConfig = { plugin: ["example-plugin@latest"] }
  const bad = await runPreflight(root, validateManifest(moving))
  assert.equal(bad.ok, false)
  assert.ok(bad.checks.some((item) => item.id.includes("example-plugin@latest") && item.status === "error"))

  const pinned = baseManifest()
  pinned.competitors[0].opencodeConfig = { plugin: ["example-plugin@1.2.3"] }
  const good = await runPreflight(root, validateManifest(pinned))
  assert.equal(good.ok, true)
})

test("preflight rejects reproducibility metadata placeholders before model spend", async () => {
  const manifest = baseManifest()
  manifest.metadata.model = "PIN_EXACT_PROVIDER_MODEL"
  const report = await runPreflight(root, validateManifest(manifest))
  assert.equal(report.ok, false)
  const check = report.checks.find((item) => item.id === "metadata:placeholders")
  assert.equal(check.status, "error")
})

test("requiredEnv must also be passed into isolated child runs", () => {
  assert.throws(() => validateManifest({ ...baseManifest(), requiredEnv: ["PROVIDER_KEY"] }), /must also appear in manifest.passEnv/)
})


test("--preflight CLI writes JSON and Markdown without executing benchmark agents", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-preflight-cli-"))
  try {
    const manifestPath = path.join(temp, "manifest.json")
    const outDir = path.join(temp, "out")
    await writeFile(manifestPath, `${JSON.stringify(baseManifest(), null, 2)}\n`)
    const report = await benchmarkMain(["--manifest", manifestPath, "--preflight", "--out", outDir], root)
    assert.equal(report.ok, true)
    const json = JSON.parse(await readFile(path.join(outDir, "preflight.json"), "utf8"))
    const markdown = await readFile(path.join(outDir, "preflight.md"), "utf8")
    assert.equal(json.ok, true)
    assert.match(markdown, /Gate: \*\*PASS\*\*/)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test("all committed deterministic benchmark fixtures declare and satisfy an initial FAIL oracle", async () => {
  const example = JSON.parse(await readFile(path.join(root, "benchmarks", "competitive.example.json"), "utf8"))
  const manifest = validateManifest({
    ...example,
    requiredEnv: [],
    metadata: { opencodeVersion: "test", model: "test/model", provider: "test" },
    competitors: [{ id: "node", command: [process.execPath, "-e", "void 0"] }],
  })
  const report = await runPreflight(root, manifest)
  assert.equal(report.ok, true)
  assert.deepEqual(Object.keys(report.fixtureDigests).sort(), ["constraint-preservation", "false-complete-trap", "normal-completion"])
  const baselines = report.checks.filter((item) => item.id.endsWith(":oracle-baseline"))
  assert.equal(baselines.length, 3)
  assert.ok(baselines.every((item) => item.status === "pass"))
})
