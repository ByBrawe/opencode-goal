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

test("multiline pasted Goal specifications are literal even when they contain CLI-style flags", () => {
  const objective = [
    "Build the release without losing the pasted specification.",
    "",
    "Commands users may run:",
    "- npm test -- --watch=false",
    "- tool --dry-run --accept something",
    "",
    "Do not reinterpret --max-turns 1 or --wat as Goal command options here.",
  ].join("\n")
  const parsed = parseGoalCommand(objective)
  assert.equal(parsed.action, "create")
  assert.equal(parsed.objective, objective)
  assert.deepEqual(parsed.acceptance, [])
  assert.deepEqual(parsed.constraints, [])
  assert.deepEqual(parsed.checks, [])
  assert.deepEqual(parsed.files, [])
  assert.equal(parsed.maxTurns, undefined)
})

test("multiline edit and add preserve pasted body text without option parsing", () => {
  const edited = parseGoalCommand("edit Replace the workflow text exactly.\nExample: runner --accept literal --wat literal")
  assert.equal(edited.action, "edit")
  assert.equal(edited.objective, "Replace the workflow text exactly.\nExample: runner --accept literal --wat literal")
  assert.deepEqual(edited.acceptance, [])

  const added = parseGoalCommand("add Ship the follow-up.\nKeep CLI sample: tool --max-turns 1 --dry-run")
  assert.equal(added.action, "add")
  assert.equal(added.objective, "Ship the follow-up.\nKeep CLI sample: tool --max-turns 1 --dry-run")
  assert.equal(added.maxTurns, undefined)
})

test("trailing newline alone does not turn a normal control command into pasted work", () => {
  assert.equal(parseGoalCommand("status\n").action, "status")
  assert.equal(parseGoalCommand("pause\r\n").action, "pause")
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

test("goal notify is an explicit single-line Goal Contract flag", () => {
  const parsed = parseGoalCommand('ship release --check "npm test" --notify "tool {reason} {goal}" --max-turns 5')
  assert.equal(parsed.notifyCommand, "tool {reason} {goal}")
  assert.deepEqual(parsed.checks, ["npm test"])
  assert.equal(parsed.maxTurns, 5)
  assert.equal(parseGoalCommand('edit revised --notify "other {goal}"').notifyCommand, "other {goal}")
  assert.equal(parseGoalCommand('add queued --notify "queue {reason}"').notifyCommand, "queue {reason}")
})

test("goal notify fails closed when malformed and stays literal inside multiline pasted work", () => {
  assert.throws(() => parseGoalCommand("ship --notify"), /unknown goal option/)
  assert.throws(() => parseGoalCommand('budget --notify "tool {goal}"'), /accepts only/)
  const pasted = parseGoalCommand("Ship it\nExample command: tool --notify literal")
  assert.equal(pasted.notifyCommand, undefined)
  assert.match(pasted.objective, /--notify literal/)
})

test("budget command rejects contract mutation flags", () => {
  assert.throws(() => parseGoalCommand('budget --constraint "no dependency changes"'), /accepts only/)
  assert.throws(() => parseGoalCommand('budget --success "tests pass"'), /accepts only/)
})

test("unknown flags fail closed on the single-line command surface", () => {
  assert.throws(() => parseGoalCommand("ship --wat nope"), /unknown goal option/)
})

test("malformed contains contract fails closed", () => {
  assert.throws(() => parseGoalCommand('ship --contains "README.md"'), /path::exact text/)
})


test("per-unit session rotation is explicit, paired, and excluded from queued Goal creation", () => {
  const parsed = parseGoalCommand('ship plan --unit "node scripts/current-unit.mjs" --fresh-session-per-unit')
  assert.equal(parsed.unitCommand, "node scripts/current-unit.mjs")
  assert.equal(parsed.freshSessionPerUnit, true)

  assert.throws(
    () => parseGoalCommand('ship plan --unit "node scripts/current-unit.mjs"'),
    /--unit requires --fresh-session-per-unit/,
  )
  assert.throws(
    () => parseGoalCommand("ship plan --fresh-session-per-unit"),
    /requires --unit <host command>/,
  )
  assert.throws(
    () => parseGoalCommand('add queued --unit "node unit.mjs" --fresh-session-per-unit'),
    /does not support per-unit session rotation/,
  )
  assert.throws(
    () => parseGoalCommand('budget --unit "node unit.mjs" --fresh-session-per-unit'),
    /accepts only --max-turns/,
  )
})
