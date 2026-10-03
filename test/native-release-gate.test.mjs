import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { evaluateReleaseRuns, assertRegistrySource, REQUIRED_GOAL_GATES } from "../scripts/native-release-gate.mjs"
const sha = "a".repeat(40), repository = "ByBrawe/opencode-goal"
const run = (overrides = {}) => ({ id: 1, name: "CI", head_sha: sha, event: "push", head_branch: "main", repository: { full_name: repository }, status: "completed", conclusion: "success", ...overrides })
const state = (runs) => evaluateReleaseRuns(runs, ["CI"], sha, repository)[0].state

test("publication requires the exact owning-repository main push", () => {
  assert.equal(state([run()]), "passed")
  for (const change of [{ head_sha: "b".repeat(40) }, { event: "pull_request" }, { head_branch: "other" }, { repository: { full_name: "someone/fork" } }]) assert.equal(state([run(change)]), "missing")
})
test("missing, queued, skipped, cancelled and failed gates never authorize npm", () => {
  assert.equal(state([]), "missing")
  assert.equal(state([run({ status: "queued", conclusion: null })]), "pending")
  for (const conclusion of ["skipped", "cancelled", "failure", "timed_out", "neutral", null]) assert.equal(state([run({ conclusion })]), "failed")
})
test("a stale green run cannot hide a newer failed or running gate", () => {
  assert.equal(state([run(), run({ id: 2, conclusion: "failure" })]), "failed")
  assert.equal(state([run(), run({ id: 2, status: "in_progress", conclusion: null })]), "pending")
  assert.equal(state([run({ run_attempt: 1 }), run({ run_attempt: 2, conclusion: "failure" })]), "failed")
})
test("all documented native gates including actual sidebar rendering are mandatory", () => {
  assert.equal(new Set(REQUIRED_GOAL_GATES).size, 10)
  assert.ok(REQUIRED_GOAL_GATES.includes("Native Goal Sidebar"))
  assert.ok(REQUIRED_GOAL_GATES.includes("Current OpenCode 2 Stable Host"))
  assert.ok(REQUIRED_GOAL_GATES.includes("OpenCode 2 Todo Materialization Diff"))
  assert.throws(() => evaluateReleaseRuns([], [], sha, repository))
})
test("an already published immutable version must match its exact git source", () => {
  const expected = { name: "@bybrawe/opencode-goal", version: "1.3.47", sha }
  assert.doesNotThrow(() => assertRegistrySource({ name: expected.name, version: expected.version, gitHead: sha }, expected))
  for (const change of [{ gitHead: "b".repeat(40) }, { gitHead: undefined }, { name: "other" }, { version: "1.3.46" }]) assert.throws(() => assertRegistrySource({ name: expected.name, version: expected.version, gitHead: sha, ...change }, expected), /different source/)
})
test("publisher keeps immutable checkout, serialized OIDC and exact-main gates", async () => {
  const workflow = await readFile(new URL("../.github/workflows/publish-npm.yml", import.meta.url), "utf8")
  assert.match(workflow, /ref: \$\{\{ github.sha \}\}/)
  assert.match(workflow, /persist-credentials: false/)
  assert.match(workflow, /cancel-in-progress: false/)
  assert.match(workflow, /node scripts\/native-release-gate.mjs/)
  assert.match(workflow, /assertRegistrySource/)
  assert.doesNotMatch(workflow, /contents: write|git push|secrets\.NPM_TOKEN/)
  assert.ok(workflow.indexOf("node scripts/native-release-gate.mjs") < workflow.indexOf("npm publish --tag latest --access public"))
})
