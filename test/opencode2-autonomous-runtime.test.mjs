import test from "node:test"
import assert from "node:assert/strict"
import {
  armOpenCode2GoalExecution,
  clearOpenCode2GoalOwnership,
  consumeOpenCode2GoalExecution,
  consumeOpenCode2GoalKickoff,
  createOpenCode2AutonomousRuntime,
  rememberOpenCode2GoalKickoff,
  rememberOpenCode2GoalPrompt,
} from "../dist/opencode2/autonomous-runtime.js"

test("V2 autonomous ownership arms only the exact host-admitted continuation message", () => {
  const runtime = createOpenCode2AutonomousRuntime()
  const goal = { id: "goal-1", revision: 4 }

  rememberOpenCode2GoalPrompt(runtime, "session-1", "user-goal-continuation", goal, "execution")

  assert.equal(
    armOpenCode2GoalExecution(runtime, "session-1", "ordinary-user", 7),
    undefined,
    "ordinary user context must not steal Goal turn ownership",
  )
  assert.equal(runtime.pendingPromptBySession.has("session-1"), true)

  const owner = armOpenCode2GoalExecution(runtime, "session-1", "user-goal-continuation", 8)
  assert.deepEqual(owner, {
    messageID: "user-goal-continuation",
    goalID: "goal-1",
    revision: 4,
    source: "execution",
    generation: 8,
  })
  assert.equal(runtime.pendingPromptBySession.has("session-1"), false)

  assert.equal(
    consumeOpenCode2GoalExecution(runtime, "session-1", 7),
    undefined,
    "an older terminal must not consume the owned Goal generation",
  )
  assert.deepEqual(consumeOpenCode2GoalExecution(runtime, "session-1", 8), owner)
  assert.equal(consumeOpenCode2GoalExecution(runtime, "session-1", 8), undefined)
})

test("V2 direct lifecycle kickoff is generation-bound and single-use", () => {
  const runtime = createOpenCode2AutonomousRuntime()
  const goal = { id: "goal-kickoff", revision: 2 }

  rememberOpenCode2GoalKickoff(runtime, "session-kickoff", 11, goal)
  assert.equal(consumeOpenCode2GoalKickoff(runtime, "session-kickoff", 10), undefined)
  assert.deepEqual(consumeOpenCode2GoalKickoff(runtime, "session-kickoff", 11), {
    goalID: "goal-kickoff",
    revision: 2,
    generation: 11,
  })
  assert.equal(consumeOpenCode2GoalKickoff(runtime, "session-kickoff", 11), undefined)
})

test("V2 autonomous ownership clears all session-local authority together", () => {
  const runtime = createOpenCode2AutonomousRuntime()
  const goal = { id: "goal-clear", revision: 1 }

  rememberOpenCode2GoalPrompt(runtime, "session-clear", "message-1", goal, "compaction")
  armOpenCode2GoalExecution(runtime, "session-clear", "message-1", 3)
  rememberOpenCode2GoalKickoff(runtime, "session-clear", 4, goal)

  clearOpenCode2GoalOwnership(runtime, "session-clear")
  assert.equal(runtime.pendingPromptBySession.has("session-clear"), false)
  assert.equal(runtime.executionOwnerBySession.has("session-clear"), false)
  assert.equal(runtime.kickoffBySession.has("session-clear"), false)
})
