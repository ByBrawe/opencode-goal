import test from "node:test"
import assert from "node:assert/strict"
import { createGoal } from "../dist/domain/goal.js"
import {
  applyOpenCode2AssistantStepAccounting,
  createOpenCode2TelemetryAccountingRuntime,
  observeOpenCode2AssistantTelemetry,
} from "../dist/opencode2/telemetry-accounting.js"

function owner(goal, revision = goal.revision) {
  return {
    messageID: "goal-user-message",
    goalID: goal.id,
    revision,
    generation: 1,
    source: "execution",
  }
}

test("V2 exact step telemetry maps to the same V1 assistant usage accounting", () => {
  const base = {
    ...createGoal({ sessionID: "v2-accounting", objective: "ship accounting", now: 10 }),
    emptyTurnCount: 1,
    lastEmptyTurnAt: 9,
  }
  const next = applyOpenCode2AssistantStepAccounting(base, owner(base), {
    sessionID: base.sessionID,
    assistantMessageID: "assistant-1",
    meaningful: true,
    tokens: {
      input: 10,
      output: 3,
      reasoning: 2,
      cache: { read: 7, write: 5 },
    },
    cost: 0.25,
    startedAt: 100,
    completedAt: 160,
  }, 200)

  assert.equal(next.usage.turns, 1)
  assert.equal(next.usage.tokens, 15, "Goal budget accounting matches V1 and does not double-count cache tokens")
  assert.equal(next.usage.cost, 0.25)
  assert.equal(next.usage.runtimeMs, 60)
  assert.deepEqual(next.usage.seenMessageIDs, ["assistant-1"])
  assert.equal(next.emptyTurnCount, undefined)
  assert.equal(next.lastEmptyTurnAt, undefined)
  assert.equal(next.execution?.modelContext?.lastRequestTokens, 25, "model-context pressure still includes cache usage")
  assert.equal(next.execution?.modelContext?.lastInputTokens, 22)
})

test("V2 empty assistant steps preserve usage but refund logical turns and pause after two", () => {
  const base = createGoal({ sessionID: "v2-empty", objective: "avoid empty loops", now: 10 })

  const first = applyOpenCode2AssistantStepAccounting(base, owner(base), {
    sessionID: base.sessionID,
    assistantMessageID: "empty-1",
    meaningful: false,
    tokens: { input: 12, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0.1,
    startedAt: 100,
    completedAt: 120,
  }, 120)

  assert.equal(first.status, "active")
  assert.equal(first.usage.turns, 0)
  assert.equal(first.usage.tokens, 12)
  assert.equal(first.usage.cost, 0.1)
  assert.equal(first.emptyTurnCount, 1)
  assert.equal(first.skipNextStallCheck, true)

  const second = applyOpenCode2AssistantStepAccounting(first, owner(first), {
    sessionID: base.sessionID,
    assistantMessageID: "empty-2",
    meaningful: false,
    tokens: { input: 9, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0.2,
    startedAt: 200,
    completedAt: 230,
  }, 230)

  assert.equal(second.status, "paused")
  assert.equal(second.usage.turns, 0)
  assert.equal(second.usage.tokens, 21)
  assert.equal(second.usage.cost, 0.3)
  assert.equal(second.emptyTurnCount, 2)
  assert.equal(second.skipNextStallCheck, undefined)
  assert.match(second.stopReason ?? "", /2 consecutive Goal-owned assistant turns completed without meaningful/)
})

test("V2 stale-revision empty steps account usage without applying current-turn empty policy", () => {
  const goal = {
    ...createGoal({ sessionID: "v2-stale-accounting", objective: "edited goal", now: 10 }),
    revision: 2,
  }
  const next = applyOpenCode2AssistantStepAccounting(goal, owner(goal, 1), {
    sessionID: goal.sessionID,
    assistantMessageID: "stale-empty",
    meaningful: false,
    tokens: { input: 5, output: 1, reasoning: 0 },
    cost: 0,
    startedAt: 100,
    completedAt: 110,
  }, 110)

  assert.equal(next.status, "active")
  assert.equal(next.usage.turns, 1)
  assert.equal(next.usage.tokens, 6)
  assert.equal(next.emptyTurnCount, undefined)
  assert.equal(next.skipNextStallCheck, undefined)
})

test("V2 telemetry runtime scopes meaningful activity to the exact assistant message", () => {
  const runtime = createOpenCode2TelemetryAccountingRuntime()

  observeOpenCode2AssistantTelemetry(runtime, {
    type: "session.step.started",
    created: 100,
    data: { sessionID: "s1", assistantMessageID: "a1" },
  })
  observeOpenCode2AssistantTelemetry(runtime, {
    type: "session.text.ended",
    created: 120,
    data: { sessionID: "s1", assistantMessageID: "a1", text: "done" },
  })
  const meaningful = observeOpenCode2AssistantTelemetry(runtime, {
    type: "session.step.ended",
    created: 150,
    data: {
      sessionID: "s1",
      assistantMessageID: "a1",
      tokens: { input: 2, output: 1, reasoning: 0 },
      cost: 0.01,
    },
  })
  assert.deepEqual(meaningful, {
    sessionID: "s1",
    assistantMessageID: "a1",
    meaningful: true,
    tokens: { input: 2, output: 1, reasoning: 0 },
    cost: 0.01,
    startedAt: 100,
    completedAt: 150,
  })

  observeOpenCode2AssistantTelemetry(runtime, {
    type: "session.step.started",
    created: 200,
    data: { sessionID: "s1", assistantMessageID: "tool-message" },
  })
  observeOpenCode2AssistantTelemetry(runtime, {
    type: "session.tool.input.started",
    created: 205,
    data: { sessionID: "s1", assistantMessageID: "tool-message", id: "call-1", name: "write" },
  })
  const tool = observeOpenCode2AssistantTelemetry(runtime, {
    type: "session.step.ended",
    created: 240,
    data: { sessionID: "s1", assistantMessageID: "tool-message", tokens: { input: 3, output: 2 }, cost: 0 },
  })
  assert.equal(tool?.meaningful, true)

  observeOpenCode2AssistantTelemetry(runtime, {
    type: "session.step.started",
    created: 300,
    data: { sessionID: "s1", assistantMessageID: "empty-message" },
  })
  const empty = observeOpenCode2AssistantTelemetry(runtime, {
    type: "session.step.ended",
    created: 320,
    data: { sessionID: "s1", assistantMessageID: "empty-message", tokens: { input: 4, output: 0 }, cost: 0 },
  })
  assert.equal(empty?.meaningful, false)

  observeOpenCode2AssistantTelemetry(runtime, {
    type: "session.step.started",
    created: 400,
    data: { sessionID: "s1", assistantMessageID: "leaked" },
  })
  assert.equal(runtime.assistants.size, 1)
  observeOpenCode2AssistantTelemetry(runtime, {
    type: "session.deleted",
    data: { sessionID: "s1" },
  })
  assert.equal(runtime.assistants.size, 0)
})
