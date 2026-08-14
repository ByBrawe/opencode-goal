import test from "node:test"
import assert from "node:assert/strict"
import { DEFAULT_CONFIGURED_CHECK_TIMEOUT_MS, runConfiguredChecks } from "../dist/runtime/checks.js"

function commandGoal(command) {
  const now = Date.now()
  return {
    schemaVersion: 1,
    id: "goal-check-timeout",
    sessionID: "parent",
    objective: "verify slow build support",
    revision: 1,
    status: "active",
    requirements: [{
      id: "req-check",
      text: `Verification command passes: ${command}`,
      required: true,
      status: "pending",
      evidenceIDs: [],
      verification: "command",
      source: "check",
      command,
      updatedAt: now,
    }],
    evidence: [],
    checks: [command],
    usage: { turns: 0, tokens: 0, cost: 0, runtimeMs: 0, seenMessageIDs: [] },
    budget: { maxTurns: 30, maxTokens: 400_000, maxCost: 0, maxRuntimeMs: 60 * 60_000 },
    progressRevision: 0,
    observedProgressRevision: 0,
    progressFingerprints: [],
    stalledTurns: 0,
    progressNotes: [],
    createdAt: now,
    updatedAt: now,
  }
}

test("configured completion checks allow hour-scale builds by default", () => {
  assert.equal(DEFAULT_CONFIGURED_CHECK_TIMEOUT_MS, 60 * 60_000)
})

test("configured completion check timeout remains explicitly overridable", async () => {
  const command = `"${process.execPath}" -e "setTimeout(() => {}, 500)"`
  const started = Date.now()
  const result = await runConfiguredChecks(commandGoal(command), process.cwd(), { timeoutMs: 25 })
  const elapsed = Date.now() - started

  assert.ok(elapsed < 2_000, `overridden check timeout should stop a hung check promptly, got ${elapsed}ms`)
  assert.equal(result.requirements[0].status, "failed")
  assert.equal(result.evidence.at(-1)?.passed, false)
})
