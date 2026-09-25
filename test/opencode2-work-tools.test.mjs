import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createGoal } from "../dist/domain/goal.js"
import { GoalStore } from "../dist/persistence/store.js"
import { createOpenCode2AutonomousRuntime } from "../dist/opencode2/autonomous-runtime.js"
import {
  createOpenCode2GoalWorkTools,
  OPENCODE2_GOAL_WORK_TOOLS,
} from "../dist/opencode2/work-tools.js"

function own(runtime, sessionID, goal, messageID, generation = 1) {
  runtime.executionOwnerBySession.set(sessionID, {
    messageID,
    goalID: goal.id,
    revision: goal.revision,
    generation,
    source: "execution",
  })
}

function contextEvent(sessionID, messageID, { nativeTodo = false } = {}) {
  return {
    sessionID,
    messages: [{ id: messageID, role: "user", content: "goal turn" }],
    tools: {
      ...Object.fromEntries(OPENCODE2_GOAL_WORK_TOOLS.map((name) => [name, {}])),
      ...(nativeTodo ? { todowrite: {} } : {}),
    },
  }
}

test("V2 Goal work tools are visible only to exact Goal-owned execution and preserve host/file semantics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-v2-work-tools-"))
  try {
    await writeFile(path.join(root, "proof.txt"), "OK\n", "utf8")
    const sessionID = "v2-work-tools"
    const store = new GoalStore(root)
    const goal = createGoal({
      sessionID,
      objective: "ship proof",
      files: [{ file: "proof.txt", contains: "OK" }],
      now: 100,
    })
    await store.save(goal)

    const autonomousRuntime = createOpenCode2AutonomousRuntime()
    own(autonomousRuntime, sessionID, goal, "goal-turn-1")
    const tools = createOpenCode2GoalWorkTools({
      autonomousRuntime,
      resolveDirectory: async () => root,
      semanticVerifier: { async verify(_sessionID, current) { return current } },
    })

    const foreign = contextEvent(sessionID, "ordinary-user")
    assert.equal(tools.handleContext(foreign), false)
    assert.deepEqual(Object.keys(foreign.tools), [], "ordinary foreground execution must not see Goal work tools")

    const owned = contextEvent(sessionID, "goal-turn-1")
    assert.equal(tools.handleContext(owned), true)
    assert.deepEqual(Object.keys(owned.tools).sort(), [...OPENCODE2_GOAL_WORK_TOOLS].sort())

    const nativeOwned = contextEvent(sessionID, "goal-turn-1", { nativeTodo: true })
    assert.equal(tools.handleContext(nativeOwned), true)
    assert.equal(nativeOwned.tools.todowrite !== undefined, true)
    assert.equal(
      nativeOwned.tools.opencode_goal_todo_plan,
      undefined,
      "native todowrite must suppress the Goal fallback to avoid two planning authorities",
    )

    const fallbackPlan = [
      { content: "Inspect current state", status: "completed", priority: "high" },
      { content: "Ship required fix", status: "in_progress", priority: "high" },
      { content: "Verify acceptance", status: "pending", priority: "medium" },
    ]
    const fallback = await tools.definitions.opencode_goal_todo_plan.execute(
      { todos: fallbackPlan },
      { sessionID },
    )
    assert.match(fallback.content, /advisory Goal Todo plan/i)
    let latest = await store.load(sessionID)
    assert.equal(latest.todoPlan?.source, "goal_fallback")
    assert.equal(latest.todoPlan?.goalRevision, latest.revision)
    assert.equal(latest.todoPlan?.total, 3)
    assert.equal(latest.progressRevision, 0, "Todo fallback must not manufacture verified progress")
    assert.deepEqual(latest.evidence, [], "Todo fallback must not create completion evidence")

    assert.equal(
      await tools.observeNativeTodoEvent({
        type: "todo.updated",
        properties: { sessionID, todos: fallbackPlan },
      }),
      true,
    )
    latest = await store.load(sessionID)
    assert.equal(latest.todoPlan?.source, "native", "native host Todo state must upgrade a fallback snapshot")

    const progress = await tools.definitions.opencode_goal_progress.execute(
      { summary: "checkpoint", next: "verify proof" },
      { sessionID },
    )
    assert.match(progress.content, /not completion evidence/i)
    latest = await store.load(sessionID)
    assert.equal(latest.progressNotes.length, 1)
    assert.equal(latest.progressRevision, 0, "model-authored checkpoint must not manufacture verified progress")

    const fileRequirement = latest.requirements.find((item) => item.verification === "file")
    assert.ok(fileRequirement)
    const evidence = await tools.definitions.opencode_goal_evidence_file.execute(
      { requirementID: fileRequirement.id },
      { sessionID },
    )
    assert.match(evidence.content, /proof\.txt/i)
    latest = await store.load(sessionID)
    assert.equal(latest.requirements.find((item) => item.id === fileRequirement.id)?.status, "proven")
    assert.equal(latest.evidence.some((item) => item.trust === "host" && item.kind === "file" && item.passed === true), true)

    autonomousRuntime.executionOwnerBySession.delete(sessionID)
    const beforeRejectedTodo = await store.load(sessionID)
    const rejectedTodo = await tools.definitions.opencode_goal_todo_plan.execute(
      { todos: [{ content: "Spoof foreground plan", status: "pending" }] },
      { sessionID },
    )
    assert.match(rejectedTodo.content, /not owned by the current Goal execution/i)
    assert.equal(
      await tools.observeNativeTodoEvent({
        type: "todo.updated",
        properties: {
          sessionID,
          todos: [{ content: "Unowned native plan", status: "pending" }],
        },
      }),
      false,
    )
    assert.deepEqual(await store.load(sessionID), beforeRejectedTodo)

    const rejected = await tools.definitions.opencode_goal_wait_for_user.execute(
      { reason: "need approval" },
      { sessionID },
    )
    assert.match(rejected.content, /not owned by the current Goal execution/i)
    assert.equal((await store.load(sessionID)).status, "active")

    own(autonomousRuntime, sessionID, latest, "goal-turn-2", 2)
    const waiting = await tools.definitions.opencode_goal_wait_for_user.execute(
      { reason: "need approval", needed: "user confirms release" },
      { sessionID },
    )
    assert.match(waiting.content, /waiting for user input/i)
    latest = await store.load(sessionID)
    assert.equal(latest.status, "waiting_user")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V2 blocker tool requires distinct owned Goal turns and blocks only on the third repeat", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-v2-blocker-"))
  try {
    const sessionID = "v2-blocker"
    const store = new GoalStore(root)
    const goal = createGoal({ sessionID, objective: "ship despite blocker", now: 100 })
    await store.save(goal)

    const autonomousRuntime = createOpenCode2AutonomousRuntime()
    const tools = createOpenCode2GoalWorkTools({
      autonomousRuntime,
      resolveDirectory: async () => root,
      semanticVerifier: { async verify(_sessionID, current) { return current } },
    })

    for (const [index, expected] of ["active", "active", "blocked"].entries()) {
      const current = await store.load(sessionID)
      own(autonomousRuntime, sessionID, current, `goal-turn-${index + 1}`, index + 1)
      const result = await tools.definitions.opencode_goal_blocked.execute(
        { reason: "upstream service unavailable", key: "upstream-service" },
        { sessionID },
      )
      const latest = await store.load(sessionID)
      assert.equal(latest.status, expected)
      assert.equal(latest.blockerAudit?.consecutiveTurns, index + 1)
      assert.match(result.content, index === 2 ? /blocked after 3/i : new RegExp(`${index + 1}\/3`))
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
