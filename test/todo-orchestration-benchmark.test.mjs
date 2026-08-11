import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { validateManifest } from "../scripts/benchmark/manifest.mjs"
import { installLocalGoalPlugin } from "../scripts/benchmark/install-local-goal-plugin.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const fixture = path.join(root, "benchmarks", "fixtures", "goal-todo-orchestration")
const oracle = path.join(root, "benchmarks", "oracles", "goal-todo-orchestration.mjs")
const manifestPath = path.join(root, "benchmarks", "goal-todo-orchestration.model.example.json")
const OBJECTIVE = "Analyze this project and finish every required existing-scope gap. Use the repository's current documentation and tests as the source of required work. Do not invent new features or change frozen contracts. Finish only when the repository is actually ready."

function runOracle(workspace) {
  return spawnSync(process.execPath, [oracle, workspace], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  })
}

async function writePassingGoal(workspace, patch = {}) {
  const goalDir = path.join(workspace, ".opencode", "goals")
  await mkdir(goalDir, { recursive: true })
  const goal = {
    schemaVersion: 1,
    id: "goal-oracle-fixture",
    sessionID: "session-oracle-fixture",
    objective: OBJECTIVE,
    revision: 1,
    status: "completed",
    requirements: [{ id: "objective", status: "proven", required: true }],
    evidence: [{ id: "verifier", trust: "verifier", kind: "runtime", passed: true }],
    progressRevision: 2,
    todoPlan: {
      goalRevision: 1,
      digest: "sha256:test",
      total: 3,
      pending: 0,
      inProgress: 0,
      completed: 3,
      cancelled: 0,
      observedAt: 1,
    },
    ...patch,
  }
  await writeFile(path.join(goalDir, "goal.json"), `${JSON.stringify(goal, null, 2)}\n`)
}

test("broad Goal Todo model manifest is structurally valid and pins the real-host OpenCode version", async () => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  validateManifest(manifest)
  assert.equal(manifest.metadata.opencodeVersion, "1.18.16")
  assert.equal(manifest.competitors.length, 1)
  assert.equal(manifest.competitors[0].id, "opencode-goals-todo-local")
  assert.deepEqual(manifest.scenarios.map((item) => item.id), ["broad-project-analysis-todo-orchestration"])
  assert.match(manifest.scenarios[0].setup.command.join(" "), /install-local-goal-plugin\.mjs/)
})

test("broad Goal Todo oracle starts red and requires repository correctness plus reconciled Todo state", async () => {
  const initial = runOracle(fixture)
  assert.notEqual(initial.status, 0, "committed fixture must start red before any model work")

  const workspace = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-todo-oracle-"))
  try {
    await cp(fixture, workspace, { recursive: true })
    await writeFile(path.join(workspace, "src", "label.js"), `export function normalizeLabel(value) {\n  return String(value).trim().toLowerCase().replace(/\\s+/g, "-")\n}\n`)
    await writeFile(path.join(workspace, "STATUS.md"), "READY\n")
    await writePassingGoal(workspace)

    const passing = runOracle(workspace)
    assert.equal(passing.status, 0, `intended completed state should pass:\n${passing.stderr || passing.stdout}`)

    await writePassingGoal(workspace, {
      todoPlan: {
        goalRevision: 1,
        digest: "sha256:pending",
        total: 3,
        pending: 1,
        inProgress: 0,
        completed: 2,
        cancelled: 0,
        observedAt: 2,
      },
    })
    const pending = runOracle(workspace)
    assert.notEqual(pending.status, 0, "correct files cannot hide unfinished native Todo work")
    assert.match(`${pending.stderr}\n${pending.stdout}`, /pending Todo work/)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test("local benchmark plugin installer points disposable OpenCode at the built checkout entry", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-local-plugin-"))
  const entryDir = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-local-entry-"))
  try {
    const entry = path.join(entryDir, "index.js")
    await writeFile(entry, "export default async function plugin() { return {} }\n")
    const target = await installLocalGoalPlugin(workspace, entry)
    const source = await readFile(target, "utf8")
    assert.match(source, /OpenCodeGoalPlugin/)
    assert.match(source, new RegExp(pathToFileURL(entry).href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(entryDir, { recursive: true, force: true })
  }
})
