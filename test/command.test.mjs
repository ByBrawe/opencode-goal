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

test("unknown flags fail closed", () => {
  assert.throws(() => parseGoalCommand("ship --wat nope"), /unknown goal option/)
})

test("malformed contains contract fails closed", () => {
  assert.throws(() => parseGoalCommand('ship --contains "README.md"'), /path::exact text/)
})
