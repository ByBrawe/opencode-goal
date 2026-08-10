import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { executeRun, materializeCommand, runPreflight, validateManifest } from "../scripts/competitive-benchmark.mjs"

const appendPrompt = `const fs = require("node:fs"); fs.appendFileSync(process.argv[1], process.argv[2] + "\\n")`
const exactFile = `const fs = require("node:fs"); let actual = ""; try { actual = fs.readFileSync(process.argv[1], "utf8") } catch {}; process.exit(actual === process.argv[2] ? 0 : 1)`

function competitor() {
  return {
    id: "stateful-driver",
    command: [process.execPath, "-e", appendPrompt, "{workspace}/steps.log", "{prompt}"],
  }
}

async function fixtureRoot(prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix))
  await mkdir(path.join(root, "fixture"), { recursive: true })
  return root
}

test("stateful benchmark manifest accepts ordered steps and exposes the step template", () => {
  const manifest = {
    schemaVersion: 1,
    competitors: [competitor()],
    scenarios: [{
      id: "ordered",
      category: "workflow",
      weight: 5,
      workspace: "fixture",
      steps: [
        { id: "create", prompt: "first" },
        { id: "queue", prompt: "second", oracle: { command: [process.execPath, "-e", "process.exit(1)"], expect: "fail" } },
      ],
      oracle: { command: [process.execPath, "-e", "process.exit(0)"] },
    }],
  }
  assert.equal(validateManifest(manifest), manifest)
  assert.deepEqual(materializeCommand(["{step}:{prompt}"], {
    root: "r", workspace: "w", home: "h", prompt: "second", competitor: "c", scenario: "s", run: "1", step: "queue",
  }), ["queue:second"])

  assert.throws(() => validateManifest({
    ...manifest,
    scenarios: [{ ...manifest.scenarios[0], prompt: "legacy and stateful cannot mix" }],
  }), /exactly one of prompt or steps/)
  assert.throws(() => validateManifest({
    ...manifest,
    scenarios: [{ ...manifest.scenarios[0], steps: [{ id: "dup", prompt: "one" }, { id: "dup", prompt: "two" }] }],
  }), /duplicate step id/)
  assert.throws(() => validateManifest({
    ...manifest,
    scenarios: [{ ...manifest.scenarios[0], steps: [{ id: "bad", prompt: "one", oracle: { command: [process.execPath], expect: "maybe" } }] }],
  }), /expect must be pass or fail/)
})

test("stateful benchmark requires every intermediate invariant and the final oracle", async () => {
  const root = await fixtureRoot("opencode-goal-stateful-pass-")
  try {
    const scenario = {
      id: "ordered",
      category: "workflow",
      weight: 5,
      workspace: "fixture",
      steps: [
        {
          id: "first",
          prompt: "first",
          oracle: { command: [process.execPath, "-e", exactFile, "{workspace}/steps.log", "first\n"], expect: "pass" },
        },
        {
          id: "second",
          prompt: "second",
          oracle: { command: [process.execPath, "-e", exactFile, "{workspace}/steps.log", "never\n"], expect: "fail" },
        },
      ],
      oracle: { command: [process.execPath, "-e", exactFile, "{workspace}/steps.log", "first\nsecond\n"] },
    }
    const manifest = validateManifest({ schemaVersion: 1, repeats: 1, competitors: [competitor()], scenarios: [scenario] })
    const result = await executeRun(root, manifest, { competitor: manifest.competitors[0], scenario, repeat: 1 }, false)
    assert.equal(result.passed, true)
    assert.equal(result.infrastructureFailure, false)
    assert.equal(result.stepFailure, null)
    assert.equal(result.agentSteps.length, 2)
    assert.deepEqual(result.stepOracles.map((item) => [item.id, item.expected, item.actual, item.matched]), [
      ["first", "pass", "pass", true],
      ["second", "fail", "fail", true],
    ])
    assert.equal(result.oracle.exitCode, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("stateful benchmark stops later agent steps after an intermediate oracle mismatch", async () => {
  const root = await fixtureRoot("opencode-goal-stateful-stop-")
  try {
    const scenario = {
      id: "ordering-trap",
      category: "safety",
      weight: 5,
      workspace: "fixture",
      steps: [
        {
          id: "first",
          prompt: "first",
          oracle: { command: [process.execPath, "-e", exactFile, "{workspace}/steps.log", "first\n"], expect: "fail" },
        },
        { id: "must-not-run", prompt: "second" },
      ],
      oracle: { command: [process.execPath, "-e", exactFile, "{workspace}/steps.log", "first\n"] },
    }
    const manifest = validateManifest({ schemaVersion: 1, repeats: 1, competitors: [competitor()], scenarios: [scenario] })
    const result = await executeRun(root, manifest, { competitor: manifest.competitors[0], scenario, repeat: 1 }, false)
    assert.equal(result.passed, false, "final green state must not erase an earlier invariant failure")
    assert.deepEqual(result.stepFailure, { id: "first", index: 0, expected: "fail", actual: "pass" })
    assert.equal(result.agentSteps.length, 1, "later steps must not run after the invariant mismatch")
    assert.equal(result.oracle.exitCode, 0, "final oracle remains available for diagnostics")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("stateful benchmark preflight works without a legacy scenario prompt", async () => {
  const root = await fixtureRoot("opencode-goal-stateful-preflight-")
  try {
    const manifest = validateManifest({
      schemaVersion: 1,
      repeats: 1,
      competitors: [competitor()],
      scenarios: [{
        id: "preflight-stateful",
        category: "workflow",
        weight: 1,
        workspace: "fixture",
        steps: [{ id: "one", prompt: "first", oracle: { command: [process.execPath, "-e", "process.exit(1)"], expect: "fail" } }],
        oracle: { command: [process.execPath, "-e", "process.exit(1)"] },
        preflightOracle: "fail",
      }],
    })
    const report = await runPreflight(root, manifest)
    assert.equal(report.ok, true)
    assert.ok(report.checks.some((item) => item.id === "scenario:preflight-stateful:step:one:oracle" && item.status === "pass"))
    assert.ok(report.checks.some((item) => item.id === "scenario:preflight-stateful:oracle-baseline" && item.status === "pass"))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
