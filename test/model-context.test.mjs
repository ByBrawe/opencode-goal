import test from "node:test"
import assert from "node:assert/strict"
import { createGoal } from "../dist/domain/goal.js"
import { formatModelContext, observeModelContextLimits, observeModelContextUsage } from "../dist/runtime/model-context.js"
import { compactionContext } from "../dist/opencode/prompt.js"

test("model context telemetry stays separate from cumulative Goal token usage", () => {
  let goal = createGoal({
    sessionID: "context",
    objective: "finish the work",
    execution: { model: { providerID: "opencode", modelID: "deepseek-v4-flash-free" } },
  })
  goal.usage.tokens = 400_000

  goal = observeModelContextLimits(goal, {
    model: { limit: { context: 200_000, input: 180_000, output: 20_000 } },
    autoCompaction: true,
    compactionReserved: 16_000,
    now: 100,
  })
  goal = observeModelContextUsage(goal, {
    input: 35_000,
    output: 2_000,
    cache: { read: 1_000, write: 0 },
  }, 200)

  assert.equal(goal.usage.tokens, 400_000, "cumulative Goal budget must not be rewritten by model-window telemetry")
  assert.equal(goal.execution.modelContext.contextLimit, 200_000)
  assert.equal(goal.execution.modelContext.lastRequestTokens, 38_000)
  assert.equal(goal.execution.modelContext.autoCompaction, true)
  assert.match(formatModelContext(goal), /38,000 \/ 200,000 context \(19\.0%\)/)
  assert.match(formatModelContext(goal), /OpenCode auto-compaction on/)
})

test("compaction context preserves Goal host progress and model-window telemetry", () => {
  let goal = createGoal({
    sessionID: "compact-context",
    objective: "keep the contract across compaction",
    execution: { model: { providerID: "provider", modelID: "model" } },
  })
  goal.progressRevision = 7
  goal.observedProgressRevision = 6
  goal.progressFingerprints = ["a", "b", "c"]
  goal = observeModelContextLimits(goal, {
    model: { limit: { context: 128_000, output: 8_000 } },
    autoCompaction: true,
  })

  const text = compactionContext(goal)
  assert.match(text, /Host progress: revision 7, observed 6/)
  assert.match(text, /distinct mutation fingerprints 3/)
  assert.match(text, /context window 128,000/)
  assert.match(text, /model-window telemetry, not the cumulative Goal token budget/)
})
