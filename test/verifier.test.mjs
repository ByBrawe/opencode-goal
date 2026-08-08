import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCodeGoalPlugin from "../dist/index.js"
import { createSemanticVerifierRuntime, DEFAULT_VERIFIER_AGENT } from "../dist/opencode/verifier.js"

async function stateFor(root) {
  const dir = path.join(root, ".opencode", "goals")
  const files = await readdir(dir)
  assert.equal(files.length, 1)
  return JSON.parse(await readFile(path.join(dir, files[0]), "utf8"))
}

function verificationRequest(promptText) {
  const match = String(promptText).match(/Verification request:\n([\s\S]*?)\n\nCall opencode_goal_verifier_result/)
  assert.ok(match, "verifier prompt should contain a structured verification request")
  return JSON.parse(match[1])
}

function hostEvidenceIDs(promptText) {
  const section = String(promptText).match(/Host evidence:\n([\s\S]*?)\n\nVerification request:/)?.[1] ?? ""
  return [...section.matchAll(/^- \[([^\]]+)\]/gm)].map((match) => match[1])
}

function makeClient() {
  let hooks
  let childCounter = 0
  let deleted = 0
  let onPrompt = async ({ body, childID }) => {
    const request = verificationRequest(body.parts[0].text)
    const result = await hooks.tool.opencode_goal_verifier_result.execute({
      auditToken: request.auditToken,
      results: request.requirements.map((requirement) => ({
        requirementID: requirement.id,
        verdict: "proven",
        reason: "The current README directly establishes this requirement.",
        evidence: [{ path: "README.md", quote: "Verified Goal Mode" }],
        hostEvidenceIDs: [],
      })),
    }, { sessionID: childID, messageID: "verifier-message", agent: DEFAULT_VERIFIER_AGENT })
    assert.equal(result, "Semantic verifier result accepted.")
    return {}
  }
  const client = {
    session: {
      async create() {
        childCounter += 1
        return { data: { id: `verifier-${childCounter}` } }
      },
      async prompt(arg) {
        return await onPrompt({ body: arg.body, childID: arg.path.id })
      },
      async delete() {
        deleted += 1
        return true
      },
      async abort() { return true },
    },
  }
  return {
    client,
    setHooks(value) { hooks = value },
    setPromptHandler(value) { onPrompt = value },
    get deleted() { return deleted },
  }
}

async function createGoal(hooks, argumentsText, sessionID = "parent") {
  const output = { parts: [{ type: "text", text: "raw" }] }
  await hooks["command.execute.before"]({ command: "goal", sessionID, arguments: argumentsText }, output)
  return output
}

test("verifier config is hidden, read-only, idempotent, and collision-safe", async () => {
  const runtime = createSemanticVerifierRuntime({ session: {} }, process.cwd())
  const config = {}
  runtime.configure(config)
  runtime.configure(config)
  const verifier = config.agent[DEFAULT_VERIFIER_AGENT]
  assert.equal(verifier.hidden, true)
  assert.equal(verifier.mode, "subagent")
  assert.equal(verifier.permission["*"], "deny")
  assert.equal(verifier.permission.read, "allow")
  assert.equal(verifier.tools.bash, false)
  assert.equal(verifier.tools.edit, false)
  assert.equal(verifier.tools.task, false)
  assert.equal(verifier.tools.opencode_goal_complete, false)
  assert.equal(verifier.tools.opencode_goal_verifier_result, true)

  const collision = { agent: { [DEFAULT_VERIFIER_AGENT]: { prompt: "someone else's agent" } } }
  assert.throws(() => runtime.configure(collision), /name already exists/)
})

test("semantic completion needs a separate verifier and host-corroborated exact file evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-semantic-"))
  try {
    await writeFile(path.join(root, "README.md"), "# Product\nVerified Goal Mode\n", "utf8")
    const fake = makeClient()
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
    fake.setHooks(hooks)
    await createGoal(hooks, 'ship verified docs --accept "README documents Verified Goal Mode"')

    const result = await hooks.tool.opencode_goal_complete.execute({ summary: "docs shipped" }, { sessionID: "parent", messageID: "executor-message", agent: "build" })
    assert.equal(result, "Goal completed with host and verifier-backed evidence.")
    const goal = await stateFor(root)
    assert.equal(goal.status, "completed")
    assert.equal(goal.requirements.filter((item) => item.verification === "semantic").every((item) => item.status === "proven"), true)
    assert.equal(goal.evidence.some((item) => item.trust === "verifier" && item.passed === true), true)
    assert.equal(fake.deleted, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("verifier cannot prove a semantic requirement with a hallucinated file quote", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-quote-"))
  try {
    await writeFile(path.join(root, "README.md"), "Verified Goal Mode\n", "utf8")
    const fake = makeClient()
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
    fake.setHooks(hooks)
    fake.setPromptHandler(async ({ body, childID }) => {
      const request = verificationRequest(body.parts[0].text)
      await hooks.tool.opencode_goal_verifier_result.execute({
        auditToken: request.auditToken,
        results: request.requirements.map((requirement) => ({
          requirementID: requirement.id,
          verdict: "proven",
          reason: "Claimed proof.",
          evidence: [{ path: "README.md", quote: "This quote does not exist" }],
          hostEvidenceIDs: [],
        })),
      }, { sessionID: childID, messageID: "verifier-message", agent: DEFAULT_VERIFIER_AGENT })
      return {}
    })
    await createGoal(hooks, "ship docs")
    const result = await hooks.tool.opencode_goal_complete.execute({ summary: "done" }, { sessionID: "parent", messageID: "executor-message", agent: "build" })
    assert.match(result, /failed closed/)
    assert.match(result, /quote was not found/)
    assert.equal((await stateFor(root)).status, "active")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("missing verifier result fails closed and never completes the goal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-no-verdict-"))
  try {
    await writeFile(path.join(root, "README.md"), "Verified Goal Mode\n", "utf8")
    const fake = makeClient()
    fake.setPromptHandler(async () => ({}))
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
    fake.setHooks(hooks)
    await createGoal(hooks, "ship docs")
    const result = await hooks.tool.opencode_goal_complete.execute({ summary: "done" }, { sessionID: "parent", messageID: "executor-message", agent: "build" })
    assert.match(result, /failed closed/)
    assert.match(result, /did not submit a valid result/)
    assert.equal((await stateFor(root)).status, "active")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("verifier result is session-bound and cannot be forged from the parent session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-forge-"))
  try {
    await writeFile(path.join(root, "README.md"), "Verified Goal Mode\n", "utf8")
    let releasePrompt
    let promptBody
    const fake = makeClient()
    fake.setPromptHandler(({ body }) => {
      promptBody = body
      return new Promise((resolve) => { releasePrompt = resolve })
    })
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
    fake.setHooks(hooks)
    await createGoal(hooks, "ship docs")
    const completion = hooks.tool.opencode_goal_complete.execute({ summary: "done" }, { sessionID: "parent", messageID: "executor-message", agent: "build" })
    while (!promptBody) await new Promise((resolve) => setTimeout(resolve, 5))
    const request = verificationRequest(promptBody.parts[0].text)
    const forged = await hooks.tool.opencode_goal_verifier_result.execute({
      auditToken: request.auditToken,
      results: request.requirements.map((requirement) => ({
        requirementID: requirement.id,
        verdict: "proven",
        reason: "forged",
        evidence: [{ path: "README.md", quote: "Verified Goal Mode" }],
        hostEvidenceIDs: [],
      })),
    }, { sessionID: "parent", messageID: "executor-message", agent: "build" })
    assert.match(forged, /no active semantic verification audit/)
    releasePrompt({})
    assert.match(await completion, /failed closed/)
    assert.equal((await stateFor(root)).status, "active")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("user pause wins if it arrives while independent verification is running", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-verify-race-"))
  try {
    await writeFile(path.join(root, "README.md"), "Verified Goal Mode\n", "utf8")
    let releasePrompt
    let promptBody
    let childID
    const fake = makeClient()
    fake.setPromptHandler(({ body, childID: id }) => {
      promptBody = body
      childID = id
      return new Promise((resolve) => { releasePrompt = resolve })
    })
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
    fake.setHooks(hooks)
    await createGoal(hooks, "ship docs")
    const completion = hooks.tool.opencode_goal_complete.execute({ summary: "done" }, { sessionID: "parent", messageID: "executor-message", agent: "build" })
    while (!promptBody) await new Promise((resolve) => setTimeout(resolve, 5))

    await hooks["chat.message"]({ sessionID: "parent", agent: "build" }, { parts: [{ type: "text", text: "change direction" }] })
    assert.equal((await stateFor(root)).status, "paused")

    const request = verificationRequest(promptBody.parts[0].text)
    const accepted = await hooks.tool.opencode_goal_verifier_result.execute({
      auditToken: request.auditToken,
      results: request.requirements.map((requirement) => ({
        requirementID: requirement.id,
        verdict: "proven",
        reason: "README proves it.",
        evidence: [{ path: "README.md", quote: "Verified Goal Mode" }],
        hostEvidenceIDs: [],
      })),
    }, { sessionID: childID, messageID: "verifier-message", agent: DEFAULT_VERIFIER_AGENT })
    assert.equal(accepted, "Semantic verifier result accepted.")
    releasePrompt({})
    assert.match(await completion, /goal changed, paused, or stopped/)
    assert.equal((await stateFor(root)).status, "paused")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("semantic verifier can reference fresh host file evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-hostref-"))
  try {
    await writeFile(path.join(root, "README.md"), "Verified Goal Mode\n", "utf8")
    const fake = makeClient()
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
    fake.setHooks(hooks)
    fake.setPromptHandler(async ({ body, childID }) => {
      const text = body.parts[0].text
      const request = verificationRequest(text)
      const ids = hostEvidenceIDs(text)
      assert.ok(ids.length > 0, "declared file contract should be host-verified before semantic audit")
      const result = await hooks.tool.opencode_goal_verifier_result.execute({
        auditToken: request.auditToken,
        results: request.requirements.map((requirement) => ({
          requirementID: requirement.id,
          verdict: "proven",
          reason: "The host-verified README contract establishes the requested docs state.",
          evidence: [],
          hostEvidenceIDs: [ids[0]],
        })),
      }, { sessionID: childID, messageID: "verifier-message", agent: DEFAULT_VERIFIER_AGENT })
      assert.equal(result, "Semantic verifier result accepted.")
      return {}
    })
    await createGoal(hooks, 'update docs --contains "README.md::Verified Goal Mode"')
    const result = await hooks.tool.opencode_goal_complete.execute({ summary: "done" }, { sessionID: "parent", messageID: "executor-message", agent: "build" })
    assert.equal(result, "Goal completed with host and verifier-backed evidence.")
    const goal = await stateFor(root)
    assert.equal(goal.status, "completed")
    assert.equal(goal.requirements.every((item) => item.status === "proven"), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("invented host evidence id cannot prove the objective", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-hostref-bad-"))
  try {
    await writeFile(path.join(root, "README.md"), "Verified Goal Mode\n", "utf8")
    const fake = makeClient()
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
    fake.setHooks(hooks)
    fake.setPromptHandler(async ({ body, childID }) => {
      const request = verificationRequest(body.parts[0].text)
      await hooks.tool.opencode_goal_verifier_result.execute({
        auditToken: request.auditToken,
        results: request.requirements.map((requirement) => ({
          requirementID: requirement.id,
          verdict: "proven",
          reason: "Pretend host evidence proves it.",
          evidence: [],
          hostEvidenceIDs: ["invented-evidence-id"],
        })),
      }, { sessionID: childID, messageID: "verifier-message", agent: DEFAULT_VERIFIER_AGENT })
      return {}
    })
    await createGoal(hooks, 'update docs --contains "README.md::Verified Goal Mode"')
    const result = await hooks.tool.opencode_goal_complete.execute({ summary: "done" }, { sessionID: "parent", messageID: "executor-message", agent: "build" })
    assert.match(result, /failed closed/)
    assert.match(result, /invalid or non-passing host evidence/)
    assert.equal((await stateFor(root)).status, "active")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
