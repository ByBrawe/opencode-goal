import test from "node:test"
import assert from "node:assert/strict"
import { TurnOwnership } from "../dist/opencode/ownership.js"

test("fast tool hooks inherit the pending Goal prompt owner before message.updated", () => {
  const ownership = new TurnOwnership()
  const owner = { goalID: "goal-1", revision: 1 }

  ownership.rememberPrompt("session-1", "Continue working toward the active OpenCode goal.", owner)

  const remembered = ownership.rememberActiveTool("session-1", "call-1")
  assert.deepEqual(remembered?.owner, owner)
  assert.equal(remembered?.messageID, "")
  assert.deepEqual(ownership.consumeToolCall("session-1", "call-1")?.owner, owner)
})

test("fallback tool ownership stays revision-bound across a Goal edit", () => {
  const ownership = new TurnOwnership()
  const oldOwner = { goalID: "goal-1", revision: 1 }
  const newOwner = { goalID: "goal-1", revision: 2 }

  ownership.rememberPrompt("session-1", "old continuation", oldOwner)
  ownership.rememberActiveTool("session-1", "old-call")

  ownership.rememberPrompt("session-1", "edited continuation", newOwner)
  ownership.rememberActiveTool("session-1", "new-call")

  assert.deepEqual(ownership.consumeToolCall("session-1", "old-call")?.owner, oldOwner)
  assert.deepEqual(ownership.consumeToolCall("session-1", "new-call")?.owner, newOwner)
})
