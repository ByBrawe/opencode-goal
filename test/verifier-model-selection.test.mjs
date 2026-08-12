import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createGoal } from "../dist/domain/goal.js"
import { createSemanticVerifierRuntime, DEFAULT_VERIFIER_AGENT } from "../dist/opencode/verifier.js"

test("semantic verifier model selection prefers explicit option then OpenCode small_model", () => {
  const explicit = createSemanticVerifierRuntime({ session: {} }, process.cwd(), { model: "anthropic/claude-verifier" })
  const explicitConfig = { model: "openai/default", small_model: "openai/small" }
  explicit.configure(explicitConfig)
  assert.equal(explicitConfig.agent[DEFAULT_VERIFIER_AGENT].model, "anthropic/claude-verifier")
  assert.equal(explicit.model, "anthropic/claude-verifier")

  const hostSelected = createSemanticVerifierRuntime({ session: {} }, process.cwd())
  const hostConfig = { model: "openai/default", small_model: "openai/small" }
  hostSelected.configure(hostConfig)
  assert.equal(hostConfig.agent[DEFAULT_VERIFIER_AGENT].model, "openai/small")
  assert.equal(hostSelected.model, "openai/small")

  const defaultSelected = createSemanticVerifierRuntime({ session: {} }, process.cwd())
  const defaultConfig = { model: "openai/default" }
  defaultSelected.configure(defaultConfig)
  assert.equal(defaultConfig.agent[DEFAULT_VERIFIER_AGENT].model, "openai/default")
})

test("semantic verifier prompt never inherits the Goal executor model", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-verifier-model-"))
  try {
    await writeFile(path.join(root, "README.md"), "Verified Goal Model Isolation\n", "utf8")
    let runtime
    let promptBody
    const client = {
      session: {
        async create() { return { data: { id: "verifier-child" } } },
        async prompt(arg) {
          promptBody = arg.body
          const goal = currentGoal
          const result = await runtime.resultTool.execute({
            auditToken: auditTokenFrom(arg.body.parts[0].text),
            results: [{
              requirementID: goal.requirements[0].id,
              verdict: "proven",
              reason: "The README quote establishes the requested state.",
              evidence: [{ path: "README.md", quote: "Verified Goal Model Isolation" }],
              hostEvidenceIDs: [],
            }],
          }, { sessionID: "verifier-child", messageID: "verifier-message", agent: DEFAULT_VERIFIER_AGENT })
          assert.equal(result, "Semantic verifier result accepted.")
          return {}
        },
        async delete() { return true },
        async abort() { return true },
      },
    }
    runtime = createSemanticVerifierRuntime(client, root, { timeoutMs: 1_000 })
    runtime.configure({ small_model: "openai/small" })

    const currentGoal = createGoal({
      sessionID: "parent",
      objective: "README proves model isolation",
      execution: {
        agent: "build",
        model: { providerID: "opencode", modelID: "deepseek-v4-flash-free" },
      },
    })

    const verified = await runtime.verify("parent", currentGoal, { currentMessageID: "executor-message" })
    assert.equal(verified.requirements[0].status, "proven")
    assert.equal(promptBody.agent, DEFAULT_VERIFIER_AGENT)
    assert.equal(promptBody.model, undefined, "executor model must never be copied into the verifier prompt body")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function auditTokenFrom(text) {
  const match = String(text).match(/Verification request:\n([\s\S]*?)\n\nCall opencode_goal_verifier_result/)
  assert.ok(match)
  return JSON.parse(match[1]).auditToken
}
