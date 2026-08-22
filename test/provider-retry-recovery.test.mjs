import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import CorePlugin from "../dist/opencode/plugin.js"
import {
  createGoalInfrastructureTransport,
  installGoalInfrastructureRecovery,
} from "../dist/opencode/infrastructure-recovery.js"

async function stateFor(root) {
  const dir = path.join(root, ".opencode", "goals")
  const files = (await readdir(dir)).filter((file) => file.endsWith(".json"))
  assert.equal(files.length, 1)
  return JSON.parse(await readFile(path.join(dir, files[0]), "utf8"))
}

async function createGoal(hooks, sessionID = "parent") {
  const output = { parts: [{ type: "text", text: "raw" }] }
  await hooks["command.execute.before"]({ command: "goal", sessionID, arguments: "finish the requested work" }, output)
}

async function makeHooks(root, client, options = {}) {
  const transport = createGoalInfrastructureTransport(client)
  const hooks = await CorePlugin({ client: transport.client, directory: root }, { verifierTimeoutMs: 10 })
  installGoalInfrastructureRecovery(
    { client, directory: root },
    hooks,
    transport,
    {
      retryBaseMs: options.retryBaseMs ?? 100,
      retryMaxMs: options.retryMaxMs ?? 400,
      retryPollMs: options.retryPollMs ?? 10,
      retryWatchdogMs: options.retryWatchdogMs ?? 1000,
    },
  )
  return hooks
}

async function waitFor(predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail("condition was not met before timeout")
}

test("explicit host retry is persisted and a completed assistant turn cancels recovery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-provider-retry-complete-"))
  let parentPrompts = 0
  let liveStatus = "retry"
  try {
    const client = {
      session: {
        async prompt(arg) {
          if (arg?.path?.id === "parent") parentPrompts += 1
          return {}
        },
        async status() { return { data: { parent: { type: liveStatus } } } },
        async abort() { return true },
      },
    }
    const hooks = await makeHooks(root, client)
    await createGoal(hooks)

    await hooks.event({ event: { type: "session.status", properties: { sessionID: "parent", status: { type: "retry" } } } })
    const recovering = await stateFor(root)
    assert.equal(recovering.status, "active")
    assert.equal(recovering.infrastructureRecovery?.kind, "provider_retry")
    assert.ok(recovering.infrastructureRecovery?.nextRetryAt > Date.now())

    await hooks.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "assistant-retried",
            sessionID: "parent",
            role: "assistant",
            time: { created: 10, completed: 20 },
            tokens: { input: 1, output: 1, reasoning: 0 },
            cost: 0,
          },
        },
      },
    })
    liveStatus = "idle"
    const cleared = await stateFor(root)
    assert.equal(cleared.infrastructureRecovery, undefined, "host completion must cancel the plugin fallback")

    await new Promise((resolve) => setTimeout(resolve, 160))
    assert.equal(parentPrompts, 0, "cleared retry fallback must not inject a late duplicate continuation")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("due infrastructure recovery never dispatches over a real busy foreground turn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-provider-busy-gate-"))
  let parentPrompts = 0
  let liveStatus = "busy"
  try {
    const client = {
      session: {
        async create() { return await new Promise(() => {}) },
        async prompt(arg) {
          if (arg?.path?.id === "parent") parentPrompts += 1
          return {}
        },
        async status() { return { data: { parent: { type: liveStatus } } } },
        async abort() { return true },
        async delete() { return true },
      },
    }
    const hooks = await makeHooks(root, client)
    await createGoal(hooks)
    await hooks.tool.opencode_goal_complete.execute(
      { summary: "done" },
      { sessionID: "parent", messageID: "executor-current", agent: "build" },
    )

    await new Promise((resolve) => setTimeout(resolve, 180))
    assert.equal(parentPrompts, 0, "busy user/model ownership must outrank an expired recovery timer")

    liveStatus = "idle"
    await waitFor(() => parentPrompts === 1)
    assert.equal(parentPrompts, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
