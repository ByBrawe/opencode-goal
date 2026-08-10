import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { validateManifest } from "../scripts/benchmark/manifest.mjs"
import { runPreflight } from "../scripts/benchmark/preflight.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function manifestWithConfig(model) {
  return validateManifest({
    schemaVersion: 1,
    repeats: 1,
    metadata: { opencodeVersion: "1.18.16", model: "provider/model", provider: "provider" },
    competitors: [{
      id: "node",
      command: [process.execPath, "-e", "void 0"],
      opencodeConfig: { $schema: "https://opencode.ai/config.json", model },
    }],
    scenarios: [{
      id: "normal-completion",
      category: "correctness",
      weight: 1,
      workspace: "benchmarks/fixtures/normal-completion",
      prompt: "fix it",
      preflightOracle: "fail",
      oracle: { command: [process.execPath, "{root}/benchmarks/oracles/normal-completion.mjs", "{workspace}"] },
    }],
  })
}

test("preflight rejects a forgotten model placeholder inside competitor OpenCode config", async () => {
  const report = await runPreflight(root, manifestWithConfig("PIN_EXACT_PROVIDER_MODEL"))
  assert.equal(report.ok, false)
  const check = report.checks.find((item) => item.id === "competitor:node:config-placeholders")
  assert.equal(check?.status, "error")
  assert.deepEqual(check?.details, ["competitor:node:opencodeConfig.model"])
})

test("preflight accepts a concretely pinned competitor OpenCode model config", async () => {
  const report = await runPreflight(root, manifestWithConfig("provider/model"))
  assert.equal(report.ok, true)
  const check = report.checks.find((item) => item.id === "competitor:node:config-placeholders")
  assert.equal(check?.status, "pass")
})
