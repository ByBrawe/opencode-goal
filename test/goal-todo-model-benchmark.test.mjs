import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { validateManifest } from "../scripts/benchmark/manifest.mjs"
import { runPreflight } from "../scripts/benchmark/preflight.mjs"
import { installLocalGoalPlugin } from "../scripts/benchmark/install-local-goal-plugin.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const manifestPath = path.join(root, "benchmarks", "goal-todo-orchestration.model.example.json")

async function readExample() {
  return JSON.parse(await readFile(manifestPath, "utf8"))
}

async function withDummyProviderKey(fn) {
  const name = "OPENAI_API_KEY"
  const before = process.env[name]
  process.env[name] = "model-benchmark-preflight-dummy-key"
  try {
    return await fn()
  } finally {
    if (before === undefined) delete process.env[name]
    else process.env[name] = before
  }
}

test("committed Goal-to-Todo model manifest blocks unresolved model/provider placeholders", async () => {
  await withDummyProviderKey(async () => {
    const report = await runPreflight(root, validateManifest(await readExample()))
    assert.equal(report.ok, false)
    assert.ok(report.checks.some((item) => item.id === "metadata:placeholders" && item.status === "error"))
    assert.ok(report.checks.some((item) => item.id.endsWith(":config-placeholders") && item.status === "error"))
  })
})

test("resolved Goal-to-Todo model manifest passes no-model preflight with a red baseline oracle", async () => {
  await withDummyProviderKey(async () => {
    const example = await readExample()
    const resolved = {
      ...example,
      metadata: {
        ...example.metadata,
        model: "test-provider/test-model",
        provider: "test-provider",
      },
      competitors: example.competitors.map((competitor) => ({
        ...competitor,
        opencodeConfig: {
          ...competitor.opencodeConfig,
          model: "test-provider/test-model",
        },
      })),
    }
    const report = await runPreflight(root, validateManifest(resolved))
    assert.equal(report.ok, true, JSON.stringify(report.checks, null, 2))
    assert.match(report.fixtureDigests["broad-project-analysis-todo-orchestration"], /^sha256:[a-f0-9]{64}$/)
    assert.ok(report.checks.some((item) => item.id.endsWith(":oracle-baseline") && item.status === "pass"))
  })
})

test("local Goal benchmark installer points the disposable workspace at this checkout build", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-local-plugin-test-"))
  try {
    const entry = path.join(root, "dist", "index.js")
    const target = await installLocalGoalPlugin(workspace, entry)
    const source = await readFile(target, "utf8")
    assert.equal(
      source,
      `export { default as OpenCodeGoalPlugin } from ${JSON.stringify(pathToFileURL(entry).href)}\n`,
    )
    assert.ok(target.startsWith(path.join(workspace, ".opencode", "plugins")))
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
