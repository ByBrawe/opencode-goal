import test from "node:test"
import assert from "node:assert/strict"
import { createGoal, pauseGoal } from "../dist/domain/goal.js"
import {
  createOpenCode2CompactionBoundaryRuntime,
  observeOpenCode2CompactionBoundary,
  prepareOpenCode2PostCompactionContinuation,
} from "../dist/opencode2/compaction-boundary.js"

function event(type, sessionID = "v2-session") {
  return { type, properties: { sessionID } }
}

test("V2 compaction execution is consumed without becoming a normal Goal turn", () => {
  const runtime = createOpenCode2CompactionBoundaryRuntime()

  let observed = observeOpenCode2CompactionBoundary(runtime, event("session.compaction.started"))
  assert.equal(observed.recognized, true)
  assert.equal(observed.compactionCompleted, false)

  observed = observeOpenCode2CompactionBoundary(runtime, event("session.compaction.ended"))
  assert.equal(observed.compactionCompleted, false)
  assert.equal(runtime.sessions.has("v2-session"), true)

  observed = observeOpenCode2CompactionBoundary(runtime, event("session.execution.succeeded"))
  assert.equal(observed.consumedExecution, true)
  assert.equal(observed.compactionCompleted, true)
  assert.equal(runtime.sessions.has("v2-session"), false)

  const duplicate = observeOpenCode2CompactionBoundary(runtime, event("session.execution.succeeded"))
  assert.equal(duplicate.recognized, false)
  assert.equal(duplicate.consumedExecution, false)
})

test("V2 compaction boundary tolerates execution success arriving before compaction ended", () => {
  const runtime = createOpenCode2CompactionBoundaryRuntime()
  observeOpenCode2CompactionBoundary(runtime, event("session.compaction.started"))

  const terminal = observeOpenCode2CompactionBoundary(runtime, event("session.execution.succeeded"))
  assert.equal(terminal.consumedExecution, true)
  assert.equal(terminal.compactionCompleted, false)

  const ended = observeOpenCode2CompactionBoundary(runtime, event("session.compaction.ended"))
  assert.equal(ended.compactionCompleted, true)
  assert.equal(runtime.sessions.has("v2-session"), false)
})

test("failed or interrupted compaction execution clears the boundary without continuation", () => {
  for (const type of ["session.execution.failed", "session.execution.interrupted"]) {
    const runtime = createOpenCode2CompactionBoundaryRuntime()
    observeOpenCode2CompactionBoundary(runtime, event("session.compaction.started"))
    const result = observeOpenCode2CompactionBoundary(runtime, event(type))
    assert.equal(result.consumedExecution, true)
    assert.equal(result.compactionCompleted, false)
    assert.equal(result.compactionFailed, true)
    assert.equal(runtime.sessions.has("v2-session"), false)
  }

  const runtime = createOpenCode2CompactionBoundaryRuntime()
  observeOpenCode2CompactionBoundary(runtime, event("session.compaction.started"))
  const failed = observeOpenCode2CompactionBoundary(runtime, event("session.compaction.failed"))
  assert.equal(failed.compactionFailed, true)
  assert.equal(failed.consumedExecution, false)
  assert.equal(runtime.sessions.has("v2-session"), false)
})

test("post-compaction continuation preserves Goal turn accounting and only resumes active Goals", () => {
  const goal = createGoal({ sessionID: "v2-session", objective: "survive V2 compaction", now: 100 })
  goal.stalledTurns = 2
  goal.progressRevision = 4
  goal.observedProgressRevision = 3

  const prepared = prepareOpenCode2PostCompactionContinuation(goal)
  assert.equal(prepared.goal, goal)
  assert.equal(prepared.goal.stalledTurns, 2)
  assert.equal(prepared.goal.progressRevision, 4)
  assert.equal(prepared.goal.observedProgressRevision, 3)
  assert.equal(prepared.shouldContinue, true)
  assert.match(prepared.prompt ?? "", /Continue working toward the active OpenCode goal/)
  assert.match(prepared.prompt ?? "", /survive V2 compaction/)

  const paused = pauseGoal(goal, "test pause", 200)
  const stopped = prepareOpenCode2PostCompactionContinuation(paused)
  assert.equal(stopped.shouldContinue, false)
  assert.equal(stopped.prompt, undefined)
})
