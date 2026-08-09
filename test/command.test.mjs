import test from "node:test"
import assert from "node:assert/strict"
import { parseGoalCommand } from "../dist/opencode/command.js"

test("goal parser keeps success criteria constraints checks and host file contracts", () => {
  const parsed = parseGoalCommand('ship release --success "tests pass" --accept "docs current" --constraint "public API stays compatible" --non-goal "do not redesign auth" --check "npm test" --file README.md --contains "package.json::opencode-goal" --max-turns 20')
  assert.equal(parsed.objective, "ship release")
  assert.deepEqual(parsed.acceptance, ["tests pass", "docs current"])
  assert.deepEqual(parsed.constraints, ["public API stays compatible", "do not redesign auth"])
  assert.deepEqual(parsed.checks, ["npm test"])
  assert.deepEqual(parsed.files, [{ file: "README.md" }, { file: "package.json", contains: "opencode-goal" }])
  assert.equal(parsed.maxTurns, 20)
})

test("goal draft parses the full Goal Contract without changing its flags", () => {
  const parsed = parseGoalCommand('draft ship safely --success "tests pass" --constraint "keep API compatible" --check "npm test" --contains "README.md::OpenCode Goals" --max-turns 12 --max-cost 3.5')
  assert.equal(parsed.action, "draft")
  assert.equal(parsed.objective, "ship safely")
  assert.deepEqual(parsed.acceptance, ["tests pass"])
  assert.deepEqual(parsed.constraints, ["keep API compatible"])
  assert.deepEqual(parsed.checks, ["npm test"])
  assert.deepEqual(parsed.files, [{ file: "README.md", contains: "OpenCode Goals" }])
  assert.equal(parsed.maxTurns, 12)
  assert.equal(parsed.maxCost, 3.5)
})

test("goal contract is a read-only no-argument command", () => {
  assert.deepEqual(parseGoalCommand("contract"), {
    action: "contract",
    objective: "",
    acceptance: [],
    constraints: [],
    checks: [],
    files: [],
  })
  assert.throws(() => parseGoalCommand("contract repair"), /does not accept arguments/)
})

test("goal doctor is a read-only no-argument command", () => {
  assert.deepEqual(parseGoalCommand("doctor"), {
    action: "doctor",
    objective: "",
    acceptance: [],
    constraints: [],
    checks: [],
    files: [],
  })
  assert.throws(() => parseGoalCommand("doctor repair"), /does not accept arguments/)
  assert.throws(() => parseGoalCommand("doctor --fix"), /does not accept arguments/)
})

test("goal list accepts an optional live Goal id prefix and rejects extra arguments", () => {
  assert.deepEqual(parseGoalCommand("list"), {
    action: "list",
    objective: "",
    acceptance: [],
    constraints: [],
    checks: [],
    files: [],
  })
  assert.equal(parseGoalCommand("list a1b2c3d4").goalIDPrefix, "a1b2c3d4")
  assert.throws(() => parseGoalCommand("list one two"), /at most one goal id prefix/)
  assert.throws(() => parseGoalCommand("list --all"), /unknown goal option/)
})

test("goal history accepts an optional id prefix and rejects extra arguments", () => {
  assert.deepEqual(parseGoalCommand("history"), {
    action: "history",
    objective: "",
    acceptance: [],
    constraints: [],
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

test("budget command rejects contract mutation flags", () => {
  assert.throws(() => parseGoalCommand('budget --constraint "no dependency changes"'), /accepts only/)
  assert.throws(() => parseGoalCommand('budget --success "tests pass"'), /accepts only/)
})

test("unknown flags fail closed", () => {
  assert.throws(() => parseGoalCommand("ship --wat nope"), /unknown goal option/)
})

test("malformed contains contract fails closed", () => {
  assert.throws(() => parseGoalCommand('ship --contains "README.md"'), /path::exact text/)
})
