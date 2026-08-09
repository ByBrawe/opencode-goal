import test from "node:test"
import assert from "node:assert/strict"
import { compactionContext, continuationPrompt } from "../dist/opencode/prompt.js"

const goal = {
  objective: "Audit the API without changing it",
  constraints: ["read-only; do not modify production files"],
  requirements: [
    { id: "r1", text: "Audit the API without changing it", required: true, status: "pending", evidenceIDs: [] },
    { id: "r2", text: "read-only; do not modify production files", required: true, status: "pending", evidenceIDs: [] },
  ],
  revision: 3,
  status: "active",
  usage: { turns: 2, tokens: 1200, cost: 0.2 },
  budget: { maxTurns: 20, maxTokens: 200000, maxCost: 10 },
}

test("continuation prompt preserves objective/authorization while normal tools operate on work state", () => {
  const prompt = continuationPrompt(goal)
  assert.match(prompt, /Preserve the full objective across turns/)
  assert.match(prompt, /Do not expand the user's authorized scope/)
  assert.match(prompt, /shell, read, edit, write, task, and test activity changes the work state/)
  assert.match(prompt, /does not replace or silently rewrite this Goal contract/)
})

test("continuation prompt requires scope-matched positive completion proof", () => {
  const prompt = continuationPrompt(goal)
  assert.match(prompt, /Match verification scope to claim scope/)
  assert.match(prompt, /narrow unit test, search result, manifest entry, or green command proves only what it actually covers/)
  assert.match(prompt, /requirement-by-requirement audit against current state/)
  assert.match(prompt, /no required work remaining/)
})

test("compaction context keeps work-plane activity separate from the persisted Goal contract", () => {
  const context = compactionContext(goal)
  assert.match(context, /persists across compaction and ordinary shell\/edit\/test work/)
  assert.match(context, /tool activity may silently replace the user's objective/)
  assert.match(context, /current trusted evidence for every required item/)
})
