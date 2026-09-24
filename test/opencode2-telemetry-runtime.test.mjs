import test from "node:test"
import assert from "node:assert/strict"
import {
  beginOpenCode2TelemetryExecution,
  clearOpenCode2TelemetrySession,
  createOpenCode2TelemetryRuntime,
  finishOpenCode2TelemetryExecution,
  observeOpenCode2TelemetryEvent,
  openCode2ToolTelemetry,
} from "../dist/opencode2/telemetry-runtime.js"

test("V2 telemetry folds a multi-step tool loop into one logical execution sample", () => {
  const runtime = createOpenCode2TelemetryRuntime()
  const sessionID = "v2-telemetry-tool-loop"

  beginOpenCode2TelemetryExecution(runtime, sessionID, 7, { created: 100 })
  observeOpenCode2TelemetryEvent(runtime, sessionID, {
    type: "session.tool.input.started",
    created: 110,
    data: { sessionID, assistantMessageID: "assistant-1", id: "call-1", name: "write" },
  })
  observeOpenCode2TelemetryEvent(runtime, sessionID, {
    type: "session.tool.called",
    created: 120,
    data: {
      sessionID,
      assistantMessageID: "assistant-1",
      id: "call-1",
      input: { filePath: "README.md", content: "proof" },
      executed: true,
    },
  })
  observeOpenCode2TelemetryEvent(runtime, sessionID, {
    type: "session.tool.success",
    created: 130,
    data: {
      sessionID,
      assistantMessageID: "assistant-1",
      id: "call-1",
      metadata: { filepath: "README.md" },
      executed: true,
    },
  })
  observeOpenCode2TelemetryEvent(runtime, sessionID, {
    type: "session.step.ended",
    created: 140,
    data: {
      sessionID,
      assistantMessageID: "assistant-1",
      tokens: { input: 20, output: 5, reasoning: 1, cache: { read: 3, write: 0 } },
      cost: 0.01,
    },
  })
  observeOpenCode2TelemetryEvent(runtime, sessionID, {
    type: "session.step.ended",
    created: 170,
    data: {
      sessionID,
      assistantMessageID: "assistant-2",
      tokens: { input: 30, output: 0, reasoning: 0 },
      cost: 0.02,
    },
  })

  const tool = openCode2ToolTelemetry(runtime, sessionID, "call-1")
  assert.equal(tool?.name, "write")
  assert.deepEqual(tool?.input, { filePath: "README.md", content: "proof" })
  assert.deepEqual(tool?.metadata, { filepath: "README.md" })

  const completed = finishOpenCode2TelemetryExecution(runtime, sessionID, 7, { created: 200 })
  assert.ok(completed)
  assert.equal(completed.meaningful, true, "tool work keeps a blank final provider step meaningful")
  assert.equal(completed.inputTokens, 50)
  assert.equal(completed.outputTokens, 5)
  assert.equal(completed.reasoningTokens, 1)
  assert.equal(completed.cost, 0.03)
  assert.equal(completed.startedAt, 100)
  assert.equal(completed.completedAt, 200)
  assert.deepEqual(completed.assistantMessageIDs, ["assistant-1", "assistant-2"])
  assert.deepEqual(completed.lastTokens, { input: 30, output: 0, reasoning: 0 })
})

test("V2 telemetry identifies a successful step with no text or tools as empty", () => {
  const runtime = createOpenCode2TelemetryRuntime()
  const sessionID = "v2-telemetry-empty"

  beginOpenCode2TelemetryExecution(runtime, sessionID, 1, { created: 100 })
  observeOpenCode2TelemetryEvent(runtime, sessionID, {
    type: "session.step.ended",
    created: 125,
    data: {
      sessionID,
      assistantMessageID: "assistant-empty",
      tokens: { input: 31, output: 0, reasoning: 0 },
      cost: 0,
    },
  })

  const completed = finishOpenCode2TelemetryExecution(runtime, sessionID, 1, { created: 130 })
  assert.ok(completed)
  assert.equal(completed.meaningful, false)
  assert.equal(completed.inputTokens, 31)
  assert.equal(completed.outputTokens, 0)
  assert.equal(completed.assistantMessageIDs[0], "assistant-empty")
})

test("V2 telemetry text activity is meaningful and terminal generations are fail-closed", () => {
  const runtime = createOpenCode2TelemetryRuntime()
  const sessionID = "v2-telemetry-text"

  beginOpenCode2TelemetryExecution(runtime, sessionID, 3, { created: 10 })
  observeOpenCode2TelemetryEvent(runtime, sessionID, {
    type: "session.text.ended",
    data: { sessionID, assistantMessageID: "assistant-text", text: "done" },
  })
  assert.equal(finishOpenCode2TelemetryExecution(runtime, sessionID, 2), undefined)

  const completed = finishOpenCode2TelemetryExecution(runtime, sessionID, 3, { created: 20 })
  assert.equal(completed?.meaningful, true)

  beginOpenCode2TelemetryExecution(runtime, sessionID, 4)
  clearOpenCode2TelemetrySession(runtime, sessionID)
  assert.equal(finishOpenCode2TelemetryExecution(runtime, sessionID, 4), undefined)
})
