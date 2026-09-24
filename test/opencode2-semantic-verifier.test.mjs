import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createGoal } from "../dist/domain/goal.js"
import {
  createOpenCode2SemanticVerifierRuntime,
  OPENCODE2_VERIFIER_RESULT_TOOL,
} from "../dist/opencode2/semantic-verifier.js"

function verificationRequest(text) {
  const marker = "Verification request:\n"
  const start = text.indexOf(marker)
  assert.ok(start >= 0, "verification request marker missing")
  const rest = text.slice(start + marker.length)
  const end = rest.indexOf("\n\nCall opencode_goal_verifier_result")
  return JSON.parse(end >= 0 ? rest.slice(0, end) : rest)
}

test("V2 semantic verifier is child-session bound, read-only, and host-corroborated", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-v2-semantic-"))
  try {
    await writeFile(path.join(root, "README.md"), "# Product\nV2 VERIFIED COMPLETION\n", "utf8")
    const goal = createGoal({
      sessionID: "parent",
      objective: "ship verified V2 completion",
      acceptance: ["README documents V2 VERIFIED COMPLETION"],
      now: 100,
    })

    let runtime
    let deleted = 0
    let releaseVerifier
    const verifierGate = new Promise((resolve) => { releaseVerifier = resolve })
    const session = {
      async create({ parentID, title }) {
        assert.equal(parentID, "parent")
        assert.equal(title, "Goal verification")
        return { id: "verifier-child" }
      },
      async prompt(input) {
        assert.equal(input.sessionID, "verifier-child")
        if (input.resume === false) return { id: "verifier-user-message" }

        assert.equal(input.id, "verifier-user-message")
        await verifierGate
        const request = verificationRequest(input.text)
        const accepted = await runtime.resultTool.execute({
          auditToken: request.auditToken,
          results: request.requirements.map((requirement) => ({
            requirementID: requirement.id,
            verdict: "proven",
            reason: "The current README contains the requested completion proof.",
            evidence: [{ path: "README.md", quote: "V2 VERIFIED COMPLETION" }],
            hostEvidenceIDs: [],
          })),
        }, { sessionID: "verifier-child" })
        assert.equal(accepted.content, "Semantic verifier result accepted.")
        return { id: "verifier-user-message" }
      },
      async wait({ sessionID }) {
        assert.equal(sessionID, "verifier-child")
        return { status: "idle" }
      },
      async delete({ sessionID }) {
        assert.equal(sessionID, "verifier-child")
        deleted += 1
      },
      async interrupt() {
        throw new Error("verifier should not need interruption")
      },
    }

    runtime = createOpenCode2SemanticVerifierRuntime(session, async (parentSessionID) => {
      assert.equal(parentSessionID, "parent")
      return root
    }, { timeoutMs: 2_000 })

    const verifierContext = {
      sessionID: "verifier-child",
      system: [],
      tools: {
        read: {},
        glob: {},
        grep: {},
        [OPENCODE2_VERIFIER_RESULT_TOOL]: {},
        write: {},
        edit: {},
        shell: {},
        execute: {},
        subagent: {},
      },
    }
    // The child is not registered until verify() creates it.
    assert.equal(runtime.handleContext(verifierContext), false)

    const verifiedPromise = runtime.verify("parent", goal, { currentMessageID: "goal-owned-turn" })

    // Wait until the child has been created and registered, then prove tool isolation.
    const deadline = Date.now() + 1_000
    while (!runtime.isVerifierSession("verifier-child") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(runtime.isVerifierSession("verifier-child"), true)

    const activeContext = {
      sessionID: "verifier-child",
      system: [],
      tools: {
        read: {},
        glob: {},
        grep: {},
        [OPENCODE2_VERIFIER_RESULT_TOOL]: {},
        write: {},
        edit: {},
        shell: {},
        execute: {},
        subagent: {},
      },
    }
    assert.equal(runtime.handleContext(activeContext), true)
    assert.deepEqual(
      Object.keys(activeContext.tools).sort(),
      ["glob", "grep", OPENCODE2_VERIFIER_RESULT_TOOL, "read"].sort(),
    )
    assert.match(activeContext.system[0]?.text ?? "", /independent completion verifier/i)

    const parentContext = {
      sessionID: "parent",
      system: [],
      tools: { [OPENCODE2_VERIFIER_RESULT_TOOL]: {}, read: {} },
    }
    assert.equal(runtime.handleContext(parentContext), false)
    assert.equal(parentContext.tools[OPENCODE2_VERIFIER_RESULT_TOOL], undefined)

    const forged = await runtime.resultTool.execute({
      auditToken: "forged",
      results: [],
    }, { sessionID: "parent" })
    assert.match(forged.content, /no active semantic verification audit/i)

    releaseVerifier()
    const verified = await verifiedPromise
    assert.equal(verified.requirements.filter((item) => item.verification === "semantic").every((item) => item.status === "proven"), true)
    assert.equal(verified.evidence.some((item) => item.trust === "verifier" && item.passed === true), true)
    assert.equal(deleted, 1)
    assert.equal(runtime.isVerifierSession("verifier-child"), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V2 semantic verifier rejects hallucinated quotes and leaves completion unproven", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-v2-semantic-bad-"))
  try {
    await writeFile(path.join(root, "README.md"), "real text only\n", "utf8")
    const goal = createGoal({ sessionID: "parent", objective: "ship docs", now: 100 })

    let runtime
    const session = {
      async create() { return { id: "child" } },
      async prompt(input) {
        if (input.resume === false) return { id: "message" }
        const request = verificationRequest(input.text)
        await runtime.resultTool.execute({
          auditToken: request.auditToken,
          results: request.requirements.map((requirement) => ({
            requirementID: requirement.id,
            verdict: "proven",
            reason: "claimed proof",
            evidence: [{ path: "README.md", quote: "hallucinated quote" }],
            hostEvidenceIDs: [],
          })),
        }, { sessionID: "child" })
        return { id: "message" }
      },
      async wait() {},
      async delete() {},
    }
    runtime = createOpenCode2SemanticVerifierRuntime(session, async () => root, { timeoutMs: 2_000 })

    await assert.rejects(
      runtime.verify("parent", goal),
      /quote was not found/i,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
