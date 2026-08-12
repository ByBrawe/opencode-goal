import test from "node:test"
import assert from "node:assert/strict"
import { createSemanticVerifierRuntime, SemanticVerifierUnavailableError } from "../dist/opencode/verifier.js"

function semanticGoal(overrides = {}) {
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
        evidenceIDs: [],
        updatedAt: Date.now(),
      },
    ],
    evidence: [],
    usage: { turns: 0, tokens: 0, cost: 0, runtimeMs: 0, seenMessageIDs: [] },
    revisionTurnBaseline: 0,
    progressFingerprints: [],
    progressRevision: 0,
    updatedAt: Date.now(),
    ...overrides,
  }
}

function verificationRequest(promptText) {
  const match = String(promptText).match(/Verification request:\n([\s\S]*?)\n\nCall opencode_goal_verifier_result/)
  assert.ok(match, "verifier prompt should contain a structured verification request")
  return JSON.parse(match[1])
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
    (error) => error instanceof SemanticVerifierUnavailableError && /semantic verifier timed out after 25ms/.test(error.message),
  )
  const elapsed = Date.now() - started

  assert.ok(elapsed < 1_000, `verifier timeout should release the parent promptly, got ${elapsed}ms`)
  assert.equal(aborted, 1)
  assert.equal(deleted, 1)
})

test("promptAsync dispatch waits for verifier tool submission without blocking on session.prompt", async () => {
  let runtime
  let promptCalls = 0
  let promptAsyncCalls = 0
  let deleted = 0
  const client = {
    session: {
      async create() {
        return { data: { id: "verifier-async" } }
      },
      async prompt() {
        promptCalls += 1
        throw new Error("synchronous prompt transport should not be used when promptAsync exists")
      },
      async promptAsync(arg) {
        promptAsyncCalls += 1
        const request = verificationRequest(arg.body.parts[0].text)
        queueMicrotask(async () => {
          const accepted = await runtime.resultTool.execute({
            auditToken: request.auditToken,
            results: request.requirements.map((requirement) => ({
              requirementID: requirement.id,
              verdict: "proven",
              reason: "Host runtime evidence establishes the requested test verdict.",
              evidence: [],
              hostEvidenceIDs: ["goal-runtime-turns-r1"],
            })),
          }, { sessionID: "verifier-async", messageID: "verifier-message" })
          assert.equal(accepted, "Semantic verifier result accepted.")
        })
        return { data: undefined }
      },
      async abort() { return true },
      async delete() {
        deleted += 1
        return true
      },
    },
  }

  runtime = createSemanticVerifierRuntime(client, process.cwd(), { timeoutMs: 250 })
  const result = await runtime.verify("parent", semanticGoal(), { currentMessageID: "executor-current" })

  assert.equal(result.requirements[0].status, "proven")
  assert.equal(promptAsyncCalls, 1)
  assert.equal(promptCalls, 0)
  assert.equal(deleted, 1)
})

test("runtime host evidence counts only current-revision turns and includes the in-flight completion turn", async () => {
  let runtime
  let promptText = ""
  const client = {
    session: {
      async create() { return { data: { id: "verifier-turn-evidence" } } },
      async promptAsync(arg) {
        promptText = arg.body.parts[0].text
        const request = verificationRequest(promptText)
        queueMicrotask(async () => {
          await runtime.resultTool.execute({
            auditToken: request.auditToken,
            results: request.requirements.map((requirement) => ({
              requirementID: requirement.id,
              verdict: "unknown",
              reason: "This test only inspects the host runtime evidence.",
              evidence: [],
              hostEvidenceIDs: [],
            })),
          }, { sessionID: "verifier-turn-evidence", messageID: "verifier-message" })
        })
        return { data: undefined }
      },
      async abort() { return true },
      async delete() { return true },
    },
  }

  runtime = createSemanticVerifierRuntime(client, process.cwd(), { timeoutMs: 250 })
  await runtime.verify("parent", semanticGoal({
    revision: 3,
    usage: { turns: 7, tokens: 0, cost: 0, runtimeMs: 0, seenMessageIDs: ["old-1", "old-2"] },
    revisionTurnBaseline: 5,
  }), { currentMessageID: "current-turn" })

  assert.match(promptText, /Host-observed Goal-owned assistant turns for the current revision, including the current completion turn when applicable: 3\./)
  assert.match(promptText, /Temporal\/process requirements such as doing an action across N distinct turns are not proven by a final file value alone/)
})

test("hung promptAsync dispatch is bounded instead of leaving completion QUEUED forever", async () => {
  let aborted = 0
  let deleted = 0
  let promptCalls = 0
  const client = {
    session: {
      async create() {
        return { data: { id: "verifier-async-dispatch-hung" } }
      },
      async prompt() {
        promptCalls += 1
        throw new Error("sync fallback should not run when promptAsync exists")
      },
      async promptAsync() {
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
    (error) => error instanceof SemanticVerifierUnavailableError && /semantic verifier timed out after 25ms/.test(error.message),
  )
  const elapsed = Date.now() - started

  assert.ok(elapsed < 1_000, `hung async dispatch should release the parent promptly, got ${elapsed}ms`)
  assert.equal(promptCalls, 0)
  assert.equal(aborted, 1)
  assert.equal(deleted, 1)
})

test("hung verifier session creation is bounded before a child id exists", async () => {
  let aborted = 0
  let deleted = 0
  const client = {
    session: {
      async create() {
        return await new Promise(() => {})
      },
      async promptAsync() {
        throw new Error("promptAsync must not run when verifier session creation never completes")
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
    (error) => error instanceof SemanticVerifierUnavailableError && /session creation failed: semantic verifier timed out after 25ms/.test(error.message),
  )
  const elapsed = Date.now() - started

  assert.ok(elapsed < 1_000, `hung verifier session creation should release the parent promptly, got ${elapsed}ms`)
  assert.equal(aborted, 0)
  assert.equal(deleted, 0)
})
