import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCodeGoalPlugin from "../dist/index.js"
import { createGoal } from "../dist/domain/goal.js"
import { GoalStore } from "../dist/persistence/store.js"
import { parseGoalCommand } from "../dist/opencode/command.js"
import { formatGoalAudit } from "../dist/opencode/audit-ux.js"

function fakeClient() {
  return {
    session: {
      prompt() { return Promise.resolve({}) },
      abort() { return Promise.resolve(true) },
    },
    tui: {
      showToast() { return Promise.resolve(true) },
    },
  }
}

async function runGoalCommand(hooks, sessionID, argumentsText) {
  const output = { parts: [{ type: "text", text: "raw args" }] }
  await hooks["command.execute.before"](
    { command: "goal", sessionID, arguments: argumentsText },
    output,
  )
  return output
}

async function bindCommandMessage(hooks, sessionID, messageID, output, agent = "build") {
  await hooks["chat.message"](
    { sessionID, messageID, agent },
    { message: { id: messageID }, parts: output.parts },
  )
}

test("goal audit is a read-only no-argument command", () => {
  assert.equal(parseGoalCommand("audit").action, "audit")
  assert.throws(() => parseGoalCommand("audit now"), /does not accept arguments/i)
  assert.throws(() => parseGoalCommand("audit --refresh"), /does not accept arguments/i)
})

test("Goal audit explains an active completion gate without mutating or pausing the Goal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-audit-"))
  try {
    const sessionID = "audit-active-session"
    const store = new GoalStore(root)
    const hooks = await OpenCodeGoalPlugin({ client: fakeClient(), directory: root })

    const createOutput = await runGoalCommand(
      hooks,
      sessionID,
      'ship audit UX --success "tests pass" --constraint "public API stays compatible" --check "npm test"',
    )
    await bindCommandMessage(hooks, sessionID, "create-command", createOutput)
    const before = await store.load(sessionID)
    assert.ok(before)
    assert.equal(before.status, "active")

    const auditOutput = await runGoalCommand(hooks, sessionID, "audit")
    const shown = auditOutput.parts[0].text
    assert.match(shown, /Goal Audit/)
    assert.match(shown, /Completion gate: NOT READY/)
    assert.match(shown, /Requirement ledger:/)
    assert.match(shown, /Evidence records:\n- none/)
    assert.match(shown, /requirement is not proven:/)
    assert.match(shown, /read-only snapshot/i)
    await bindCommandMessage(hooks, sessionID, "audit-command", auditOutput)

    const after = await store.load(sessionID)
    assert.deepEqual(after, before, "read-only audit must preserve the exact persisted Goal snapshot")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("Goal audit keeps a completed proof ledger inspectable without re-entering completion", () => {
  const base = createGoal({
    sessionID: "audit-completed-session",
    objective: "ship verified release",
    acceptance: ["tests pass"],
    checks: ["npm test"],
    execution: { agent: "build", model: { providerID: "example", modelID: "model" } },
    now: 1_700_000_000_000,
  })

  const evidence = base.requirements.map((requirement, index) => {
    const id = `evidence-${String(index + 1).padStart(4, "0")}`
    return {
      id,
      kind: requirement.verification === "command" ? "command" : "runtime",
      trust: requirement.verification === "command" ? "host" : "verifier",
      summary: requirement.verification === "command" ? "npm test exited 0" : `verified ${requirement.text}`,
      createdAt: 1_700_000_001_000 + index,
      goalRevision: base.revision,
      requirementIDs: [requirement.id],
      source: requirement.verification === "command" ? "npm test" : "independent verifier",
      passed: true,
    }
  })

  const completed = {
    ...base,
    status: "completed",
    completionSummary: "All current-revision requirements were proven.",
    requirements: base.requirements.map((requirement, index) => ({
      ...requirement,
      status: "proven",
      evidenceIDs: [evidence[index].id],
    })),
    evidence,
  }

  const report = formatGoalAudit(completed)
  assert.match(report, /Completion gate: COMPLETED/)
  assert.match(report, /Completion summary: All current-revision requirements were proven\./)
  assert.match(report, /\[proven; required; objective\/semantic\]/)
  assert.match(report, /\[PASS verifier\/runtime; current r1;/)
  assert.match(report, /\[PASS host\/command; current r1;/)
  assert.doesNotMatch(report, /cannot enter completion audit/i)
})
