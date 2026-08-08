import test from "node:test"
import assert from "node:assert/strict"
import { createSemanticVerifierRuntime } from "../dist/opencode/verifier.js"

function resolvedAction(permission, tool) {
  const rules = Object.entries(permission).map(([name, action]) => ({ name, action }))
  return rules.findLast((rule) => rule.name === "*" || rule.name === tool)?.action
}

test("verifier uses one fail-closed permission map with explicit allows after wildcard deny", () => {
  const runtime = createSemanticVerifierRuntime({ session: {} }, process.cwd())
  const config = {}
  runtime.configure(config)

  const agent = config.agent[runtime.agentName]
  assert.equal(agent.hidden, true)
  assert.equal(agent.tools, undefined)
  assert.deepEqual(Object.keys(agent.permission), [
    "*",
    "read",
    "glob",
    "grep",
    "opencode_goal_verifier_result",
  ])

  for (const tool of ["read", "glob", "grep", "opencode_goal_verifier_result"]) {
    assert.equal(resolvedAction(agent.permission, tool), "allow", `${tool} must remain visible to the verifier`)
  }
  for (const tool of ["bash", "edit", "write", "apply_patch", "task", "opencode_goal_complete"]) {
    assert.equal(resolvedAction(agent.permission, tool), "deny", `${tool} must remain denied for the verifier`)
  }
})
