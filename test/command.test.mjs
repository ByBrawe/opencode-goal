import test from "node:test"
import assert from "node:assert/strict"
import { parseGoalCommand } from "../dist/opencode/command.js"

test("goal parser keeps quoted criteria, checks, and host file contracts", () => {
  const parsed = parseGoalCommand('ship release --accept "tests pass" --check "npm test" --file README.md --contains "package.json::opencode-goal" --max-turns 20')
  assert.equal(parsed.objective, "ship release")
  assert.deepEqual(parsed.acceptance, ["tests pass"])
  assert.deepEqual(parsed.checks, ["npm test"])
  assert.deepEqual(parsed.files, [{ file: "README.md" }, { file: "package.json", contains: "opencode-goal" }])
  assert.equal(parsed.maxTurns, 20)
})

test("goal history accepts an optional id prefix and rejects extra arguments", () => {
  assert.deepEqual(parseGoalCommand("history"), {
    action: "history",
    objective: "",
    acceptance: [],
    checks: [],
    files: [],
  })
  assert.equal(parseGoalCommand("history a1b2c3d4").goalIDPrefix, "a1b2c3d4")
  assert.throws(() => parseGoalCommand("history one two"), /at most one goal id prefix/)
  assert.throws(() => parseGoalCommand("history --all"), /unknown goal option/)
})

test("goal history prune requires explicit positive retention", () => {
  const parsed = parseGoalCommand("history prune --keep 25")
  assert.equal(parsed.action, "history_prune")
  assert.equal(parsed.historyKeep, 25)
  assert.throws(() => parseGoalCommand("history prune"), /expects --keep/)
  assert.throws(() => parseGoalCommand("history prune --keep 0"), /positive integer/)
  assert.throws(() => parseGoalCommand("history prune --keep -1"), /positive integer/)
  assert.throws(() => parseGoalCommand("history prune --keep 1.5"), /positive integer/)
  assert.throws(() => parseGoalCommand("history prune --all 10"), /expects --keep/)
})

test("goal restore requires exactly one id prefix", () => {
  const parsed = parseGoalCommand("restore a1b2c3d4")
  assert.equal(parsed.action, "restore")
  assert.equal(parsed.goalIDPrefix, "a1b2c3d4")
  assert.throws(() => parseGoalCommand("restore"), /expects exactly one goal id prefix/)
  assert.throws(() => parseGoalCommand("restore one two"), /expects exactly one goal id prefix/)
  assert.throws(() => parseGoalCommand("restore --latest"), /unknown goal option/)
})

test("unknown flags fail closed", () => {
  assert.throws(() => parseGoalCommand("ship --wat nope"), /unknown goal option/)
})

test("malformed contains contract fails closed", () => {
  assert.throws(() => parseGoalCommand('ship --contains "README.md"'), /path::exact text/)
})
