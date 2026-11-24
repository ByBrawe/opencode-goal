import test from "node:test"
import assert from "node:assert/strict"
import { createGoal } from "../dist/domain/goal.js"
import {
  observeOpenCode2ModelRegistryLimits,
  selectOpenCode2RegistryModel,
} from "../dist/opencode2/model-context.js"

test("V2 model registry selects exact provider/model identity", () => {
  const selected = selectOpenCode2RegistryModel({
    data: [
      { id: "other", providerID: "p", limit: { context: 1 } },
      { modelID: "target", providerID: "p", limit: { context: 123456, output: 7890 } },
    ],
  }, { id: "target", providerID: "p" })

  assert.equal(selected?.providerID, "p")
  assert.equal(selected?.modelID, "target")
  assert.deepEqual(selected?.limit, { context: 123456, output: 7890 })
})

test("V2 model registry persists exact limits and execution model identity", async () => {
  const goal = createGoal({ sessionID: "v2-model-context", objective: "observe limits", now: 1 })
  const next = await observeOpenCode2ModelRegistryLimits(
    goal,
    {
      async list() {
        return {
          data: [{
            id: "canary",
            modelID: "canary",
            providerID: "canary",
            limit: { context: 123456, input: 110000, output: 7890 },
          }],
        }
      },
    },
    { id: "canary", providerID: "canary" },
    100,
  )

  assert.deepEqual(next.execution?.model, { providerID: "canary", modelID: "canary" })
  assert.equal(next.execution?.modelContext?.contextLimit, 123456)
  assert.equal(next.execution?.modelContext?.inputLimit, 110000)
  assert.equal(next.execution?.modelContext?.outputLimit, 7890)
  assert.equal(next.execution?.modelContext?.observedAt, 100)
})

test("V2 unchanged model limits are a semantic no-op", async () => {
  const initial = {
    ...createGoal({ sessionID: "v2-model-noop", objective: "avoid churn", now: 1 }),
    execution: {
      model: { providerID: "p", modelID: "m" },
      modelContext: {
        contextLimit: 1000,
        outputLimit: 100,
        observedAt: 50,
      },
    },
  }

  const next = await observeOpenCode2ModelRegistryLimits(
    initial,
    { list: async () => [{ id: "m", providerID: "p", limit: { context: 1000, output: 100 } }] },
    { id: "m", providerID: "p" },
    999,
  )

  assert.equal(next, initial)
  assert.equal(next.execution?.modelContext?.observedAt, 50)
})

test("V2 model switch clears stale prior-model context values", async () => {
  const initial = {
    ...createGoal({ sessionID: "v2-model-switch", objective: "switch model", now: 1 }),
    execution: {
      model: { providerID: "old", modelID: "old-model" },
      modelContext: {
        contextLimit: 999999,
        inputLimit: 888888,
        outputLimit: 777777,
        lastRequestTokens: 500000,
        lastInputTokens: 450000,
        observedAt: 10,
      },
    },
  }

  const next = await observeOpenCode2ModelRegistryLimits(
    initial,
    {
      list: async () => ({
        data: [{
          id: "new-model",
          providerID: "new",
          limit: { context: 200000, output: 12000 },
        }],
      }),
    },
    { id: "new-model", providerID: "new" },
    20,
  )

  assert.deepEqual(next.execution?.model, { providerID: "new", modelID: "new-model" })
  assert.equal(next.execution?.modelContext?.contextLimit, 200000)
  assert.equal(next.execution?.modelContext?.outputLimit, 12000)
  assert.equal(next.execution?.modelContext?.inputLimit, undefined)
  assert.equal(next.execution?.modelContext?.lastRequestTokens, undefined)
  assert.equal(next.execution?.modelContext?.lastInputTokens, undefined)
})

test("V2 unavailable model registry fails closed without inventing limits", async () => {
  const goal = createGoal({ sessionID: "v2-model-fail", objective: "fail closed", now: 1 })
  const next = await observeOpenCode2ModelRegistryLimits(
    goal,
    { list: async () => { throw new Error("registry unavailable") } },
    { id: "m", providerID: "p" },
    100,
  )
  assert.deepEqual(next.execution?.model, { providerID: "p", modelID: "m" })
  assert.equal(next.execution?.modelContext, undefined)
})


test("V2 partial or unavailable registry cannot retain another model's context", async () => {
  const initial = {
    ...createGoal({ sessionID: "v2-catalog-loading", objective: "switch", now: 1 }),
    execution: { model: { providerID: "p", modelID: "old" }, modelContext: { contextLimit: 1000, lastRequestTokens: 999, observedAt: 1 } },
  }
  const selected = { providerID: "p", id: "new" }
  for (const registry of [undefined, { list: async () => [] }, { list: async () => { throw Error("loading") } }]) {
    const next = await observeOpenCode2ModelRegistryLimits(initial, registry, selected, 2)
    assert.deepEqual(next.execution?.model, { providerID: "p", modelID: "new" })
    assert.equal(next.execution?.modelContext, undefined)
  }
  const pending = await observeOpenCode2ModelRegistryLimits(initial, { list: async () => [] }, selected, 2)
  const loaded = await observeOpenCode2ModelRegistryLimits(pending, { list: async () => [{ providerID: "p", id: "new", limit: { context: 2000, input: null, output: "" } }] }, selected, 3)
  assert.equal(loaded.execution?.modelContext?.contextLimit, 2000)
  assert.equal(loaded.execution?.modelContext?.inputLimit, undefined)
  assert.equal(loaded.execution?.modelContext?.outputLimit, undefined)
  assert.equal(await observeOpenCode2ModelRegistryLimits(loaded, { list: async () => [] }, selected, 4), loaded)
  assert.equal(await observeOpenCode2ModelRegistryLimits(loaded, { list: async () => [{ providerID: "p", id: "new", limit: { context: 2000 } }] }, selected, 4), loaded)
})
