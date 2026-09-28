import assert from "node:assert/strict"
import test from "node:test"
import { isGoalControlPlanePath } from "../dist/runtime/control-plane-path.js"

for (const value of [
  ".opencode/goal-handoff-locks",
  ".opencode/goal-handoff-locks/owner.lock/owner.json",
  "/project/.opencode/goal-handoff-locks/owner.lock",
  "C:\\project\\.opencode\\goal-handoff-locks\\owner.lock\\owner.json",
  "/PROJECT//.OPENCODE/GOAL-HANDOFF-LOCKS/owner.json",
]) {
  test(`V2 handoff lease is control state, not project progress: ${value}`, () => {
    assert.equal(isGoalControlPlanePath(value), true)
  })
}

test("handoff control-state filtering stays narrow and preserves existing roots", () => {
  for (const root of ["goals", "goal-locks", "goal-sequences", "opencode-loop"]) {
    assert.equal(isGoalControlPlanePath(`.opencode/${root}/state.json`), true)
  }
  for (const file of [".opencode/commands/goal.md", ".opencode/goal-handoff-locks-notes.md", "src/goal-handoff-locks/owner.json", ".opencode/goal-handoff-locks-example/owner.json", "README.md"]) {
    assert.equal(isGoalControlPlanePath(file), false)
  }
})
