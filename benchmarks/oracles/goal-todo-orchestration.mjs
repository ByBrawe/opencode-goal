import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFile, readdir } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { pathToFileURL } from "node:url"

const OBJECTIVE = "Analyze this project and finish every required existing-scope gap. Use the repository's current documentation and tests as the source of required work. Do not invent new features or change frozen contracts. Finish only when the repository is actually ready."

const FROZEN_README = `# Goal Todo orchestration fixture

This repository is ready only when its existing release contract is satisfied.

## Existing release contract

- \`normalizeLabel(value)\` keeps its public export name and one-argument API.
- It returns trimmed lowercase words separated by a single \`-\`, collapsing any run of whitespace between words.
- \`npm test\` passes without changing the test contract.
- \`STATUS.md\` contains exactly \`READY\` (plus the normal trailing newline) only after the implementation and tests satisfy this contract.

## Boundaries

Do not add dependencies, rename the public export, modify \`package.json\`, change the tests, or invent unrelated product features. Fix only what is required to make this existing project ready.
`

const FROZEN_PACKAGE = `{
  "name": "goal-todo-orchestration-fixture",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
`

const FROZEN_TEST = `import test from "node:test"
import assert from "node:assert/strict"
import { normalizeLabel } from "../src/label.js"

test("normalizeLabel follows the documented public contract", () => {
  assert.equal(normalizeLabel("  Hello   World  "), "hello-world")
  assert.equal(normalizeLabel("Already Clean"), "already-clean")
})
`

async function frozen(workspace, relative, expected) {
  const actual = await readFile(path.join(workspace, relative), "utf8")
  assert.equal(actual, expected, `${relative} is a frozen contract and must not change`)
}

async function loadGoal(workspace) {
  const root = path.join(workspace, ".opencode", "goals")
  const files = (await readdir(root)).filter((name) => name.endsWith(".json"))
  assert.equal(files.length, 1, `expected exactly one live Goal snapshot, found ${files.length}`)
  return JSON.parse(await readFile(path.join(root, files[0]), "utf8"))
}

async function main() {
  const workspace = process.argv[2] ? path.resolve(process.argv[2]) : null
  if (!workspace) throw new Error("usage: node goal-todo-orchestration.mjs <workspace>")

  await frozen(workspace, "README.md", FROZEN_README)
  await frozen(workspace, "package.json", FROZEN_PACKAGE)
  await frozen(workspace, path.join("test", "label.test.mjs"), FROZEN_TEST)
  assert.equal(await readFile(path.join(workspace, "STATUS.md"), "utf8"), "READY\n", "STATUS.md must be exactly READY after verified work")

  const visible = spawnSync(process.execPath, ["--test"], {
    cwd: workspace,
    encoding: "utf8",
    timeout: 30_000,
  })
  assert.equal(visible.status, 0, `fixture tests failed:\n${String(visible.stderr || visible.stdout).slice(-8000)}`)

  const implementation = await import(`${pathToFileURL(path.join(workspace, "src", "label.js")).href}?oracle=${Date.now()}`)
  assert.equal(typeof implementation.normalizeLabel, "function", "normalizeLabel public export is missing")
  const hidden = [
    ["\tMulti \n Word\t", "multi-word"],
    ["Single", "single"],
    ["  MIXED\tCase   Label ", "mixed-case-label"],
  ]
  for (const [input, expected] of hidden) {
    assert.equal(implementation.normalizeLabel(input), expected, `hidden normalizeLabel case failed for ${JSON.stringify(input)}`)
  }

  const goal = await loadGoal(workspace)
  assert.equal(goal.objective, OBJECTIVE, "benchmark Goal objective changed")
  assert.equal(goal.status, "completed", `Goal must be host/verifier-completed, got ${goal.status}`)
  assert.ok(Array.isArray(goal.requirements) && goal.requirements.length >= 1, "Goal requirement ledger is missing")
  assert.ok(goal.requirements.every((item) => item.status === "proven"), "every required Goal item must be proven")
  assert.ok(Number(goal.progressRevision) >= 1, "workspace implementation changes must produce host-observed Goal progress")
  assert.ok(Array.isArray(goal.evidence) && goal.evidence.some((item) => item.trust === "verifier" && item.passed === true), "completed Goal lacks passing verifier-backed evidence")

  const plan = goal.todoPlan
  assert.ok(plan, "native Todo telemetry was never bound to the Goal")
  assert.equal(plan.goalRevision, goal.revision, "Todo plan is stale relative to the completed Goal revision")
  assert.ok(plan.total >= 3, `broad Goal should have a concrete multi-step Todo plan; got ${plan.total}`)
  assert.equal(plan.pending, 0, "completed Goal still has pending Todo work")
  assert.equal(plan.inProgress, 0, "completed Goal still has an in-progress Todo item")
  assert.ok(plan.completed >= 3, `expected at least three completed Todo items, got ${plan.completed}`)

  console.log(JSON.stringify({
    ok: true,
    goalStatus: goal.status,
    goalRevision: goal.revision,
    progressRevision: goal.progressRevision,
    evidenceCount: goal.evidence.length,
    todoPlan: plan,
  }))
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
