import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCodeGoalPlugin from "../dist/index.js"
import { DEFAULT_VERIFIER_AGENT } from "../dist/opencode/verifier.js"

function verificationRequest(promptText) {
  const match = String(promptText).match(/Verification request:\n([\s\S]*?)\n\nCall opencode_goal_verifier_result/)
  assert.ok(match, "verifier prompt should contain a structured verification request")
  return JSON.parse(match[1])
}

async function stateFor(root) {
  const dir = path.join(root, ".opencode", "goals")
  const files = await readdir(dir)
  assert.equal(files.length, 1)
  return JSON.parse(await readFile(path.join(dir, files[0]), "utf8"))
}

function makeClient(onVerifierPrompt) {
  let hooks
  let childCounter = 0
  const client = {
    session: {
      async create() {
        childCounter += 1
        return { data: { id: `verifier-${childCounter}` } }
      },
      async prompt(arg) {
        return await onVerifierPrompt({ body: arg.body, childID: arg.path.id, hooks })
      },
      async delete() { return true },
      async abort() { return true },
    },
  }
  return { client, setHooks(value) { hooks = value } }
}

async function createGoal(hooks, argumentsText) {
  const output = { parts: [{ type: "text", text: "raw" }] }
  await hooks["command.execute.before"]({ command: "goal", sessionID: "parent", arguments: argumentsText }, output)
}

async function submitProven({ body, childID, hooks, pathValue, quote }) {
  const request = verificationRequest(body.parts[0].text)
  return await hooks.tool.opencode_goal_verifier_result.execute({
    auditToken: request.auditToken,
    results: request.requirements.map((requirement) => ({
      requirementID: requirement.id,
      verdict: "proven",
      reason: "The requested marker file establishes the semantic objective.",
      evidence: [{ path: pathValue, quote }],
      hostEvidenceIDs: [],
    })),
  }, { sessionID: childID, messageID: "verifier-message", agent: DEFAULT_VERIFIER_AGENT })
}

test("line-numbered verifier quotes are normalized before host corroboration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-evidence-lines-"))
  try {
    await writeFile(path.join(root, "test.txt"), "OK", "utf8")
    const fake = makeClient(async (input) => {
      const accepted = await submitProven({ ...input, pathValue: path.join(root, "test.txt"), quote: "1: OK" })
      assert.equal(accepted, "Semantic verifier result accepted.")
      return {}
    })
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
    fake.setHooks(hooks)
    await createGoal(hooks, 'create the marker --contains "test.txt::OK"')

    const result = await hooks.tool.opencode_goal_complete.execute({ summary: "done" }, { sessionID: "parent", messageID: "executor-message", agent: "build" })
    assert.equal(result, "Goal completed with host and verifier-backed evidence.")
    const goal = await stateFor(root)
    assert.equal(goal.status, "completed")
    assert.equal(goal.requirements.every((item) => item.status === "proven"), true)
    const semanticEvidence = goal.evidence.find((item) => item.trust === "verifier" && item.passed === true)
    assert.ok(semanticEvidence)
    assert.equal(semanticEvidence.metadata?.evidence?.[0]?.quote, "OK")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a malformed root-path citation can fall back to one matching fresh host file proof", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-evidence-root-"))
  try {
    await writeFile(path.join(root, "test.txt"), "OK", "utf8")
    const fake = makeClient(async (input) => {
      const accepted = await submitProven({ ...input, pathValue: root, quote: "1: OK" })
      assert.equal(accepted, "Semantic verifier result accepted.")
      return {}
    })
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
    fake.setHooks(hooks)
    await createGoal(hooks, 'create the marker --contains "test.txt::OK"')

    const result = await hooks.tool.opencode_goal_complete.execute({ summary: "done" }, { sessionID: "parent", messageID: "executor-message", agent: "build" })
    assert.equal(result, "Goal completed with host and verifier-backed evidence.")
    const goal = await stateFor(root)
    const semanticEvidence = goal.evidence.find((item) => item.trust === "verifier" && item.passed === true)
    assert.ok(semanticEvidence)
    assert.equal(semanticEvidence.metadata?.hostEvidenceIDs?.length > 0, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("unrelated hallucinated quotes still fail closed even when the file contract is proven", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-evidence-hallucination-"))
  try {
    await writeFile(path.join(root, "test.txt"), "OK", "utf8")
    const fake = makeClient(async (input) => {
      const accepted = await submitProven({ ...input, pathValue: path.join(root, "test.txt"), quote: "This quote does not exist" })
      assert.equal(accepted, "Semantic verifier result accepted.")
      return {}
    })
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
    fake.setHooks(hooks)
    await createGoal(hooks, 'create the marker --contains "test.txt::OK"')

    const result = await hooks.tool.opencode_goal_complete.execute({ summary: "done" }, { sessionID: "parent", messageID: "executor-message", agent: "build" })
    assert.match(result, /failed closed/)
    assert.match(result, /quote was not found/)
    assert.equal((await stateFor(root)).status, "active")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
