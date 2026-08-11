import test from "node:test"
import assert from "node:assert/strict"
import { createSemanticVerifierRuntime } from "../dist/opencode/verifier.js"

function semanticGoal() {
  return {
    id: "goal-timeout",
    sessionID: "parent",
    objective: "prove the finished work",
    revision: 1,
    status: "active",
    requirements: [
      {
        id: "req-timeout",
        text: "Objective achieved",
        required: true,
        verification: "semantic",
        status: "pending",
      },
    ],
    evidence: [],
  }
}

test("hung semantic verifier aborts quickly instead of wedging the parent Goal turn", async () => {
  let aborted = 0
  let deleted = 0
  const client = {
    session: {
      async create() {
        return { data: { id: "verifier-hung" } }
      },
      async prompt() {
        return await new Promise(() => {})
      },
      async abort() {
        aborted += 1
        return true
      },
      async delete() {
        deleted += 1
        return true
      },
    },
  }

  const runtime = createSemanticVerifierRuntime(client, process.cwd(), { timeoutMs: 25 })
  const started = Date.now()
  await assert.rejects(
    runtime.verify("parent", semanticGoal()),
    /semantic verifier timed out after 25ms/,
  )
  const elapsed = Date.now() - started

  assert.ok(elapsed < 1_000, `verifier timeout should release the parent promptly, got ${elapsed}ms`)
  assert.equal(aborted, 1)
  assert.equal(deleted, 1)
})
