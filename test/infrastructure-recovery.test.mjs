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
import {
  infrastructureRetryDelayMs,
  isTransientInfrastructureError,
} from "../dist/runtime/infrastructure-recovery.js"

async function stateFor(root) {
  const dir = path.join(root, ".opencode", "goals")
  const files = await readdir(dir)
  assert.equal(files.length, 1)
  return JSON.parse(await readFile(path.join(dir, files[0]), "utf8"))
}

async function createGoal(hooks, sessionID = "parent") {
  const output = { parts: [{ type: "text", text: "raw" }] }
  await hooks["command.execute.before"]({ command: "goal", sessionID, arguments: "finish the requested work" }, output)
  return output
}

async function waitFor(predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail("condition was not met before timeout")
}

async function recoveryPlugin(root, client, options = {}) {
  const transport = createGoalInfrastructureTransport(client)
  const hooks = await CorePlugin({ client: transport.client, directory: root }, { verifierTimeoutMs: options.verifierTimeoutMs ?? 10 })
  installGoalInfrastructureRecovery(
    { client, directory: root },
    hooks,
    transport,
    {
      retryBaseMs: options.retryBaseMs ?? 25,
      retryMaxMs: options.retryMaxMs ?? 100,
      retryPollMs: options.retryPollMs ?? 10,
      retryWatchdogMs: options.retryWatchdogMs ?? 500,
    },
  )
  return hooks
}

test("transient error classifier covers the network failures OpenCode retries upstream", () => {
  for (const value of [
    "fetch failed",
    "network connection lost",
    "ECONNRESET",
    "EAI_AGAIN",
    "ETIMEDOUT",
    "socket hang up",
    "HTTP 503 service unavailable",
  ]) assert.equal(isTransientInfrastructureError(value), true, value)
  assert.equal(isTransientInfrastructureError("HTTP 401 invalid API key"), false)
  assert.equal(infrastructureRetryDelayMs(1, 10, 80), 10)
  assert.equal(infrastructureRetryDelayMs(2, 10, 80), 20)
  assert.equal(infrastructureRetryDelayMs(8, 10, 80), 80)
})

test("verifier outage stays active, suppresses immediate idle, and wakes automatically after cooldown", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-infra-verifier-"))
  let parentPrompts = 0
  try {
    const client = {
      session: {
        async create() { return await new Promise(() => {}) },
        async prompt(arg) {
          if (arg?.path?.id === "parent") parentPrompts += 1
          return {}
        },
        async status() { return { data: { parent: { type: "idle" } } } },
        async abort() { return true },
        async delete() { return true },
      },
    }
    const hooks = await recoveryPlugin(root, client)
    await createGoal(hooks)

    const result = await hooks.tool.opencode_goal_complete.execute(
      { summary: "done" },
      { sessionID: "parent", messageID: "executor-current", agent: "build" },
    )
    assert.match(result, /Goal remains active and will retry automatically/)
    const recovering = await stateFor(root)
    assert.equal(recovering.status, "active")
    assert.equal(recovering.infrastructureRecovery.kind, "semantic_verifier")
    assert.ok(recovering.infrastructureRecovery.nextRetryAt > Date.now())

    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
    assert.equal(parentPrompts, 0, "host idle must not bypass verifier cooldown")

    await waitFor(() => parentPrompts === 1)
    const dispatched = await stateFor(root)
    assert.equal(dispatched.status, "active")
    assert.equal(dispatched.infrastructureRecovery.nextRetryAt, 0)
    assert.equal(dispatched.stalledTurns, 0, "infrastructure-only recovery must not spend the no-progress budget")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("transient continuation transport failure is recovered instead of permanently pausing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-infra-dispatch-"))
  let promptCalls = 0
  try {
    const client = {
      session: {
        async prompt() {
          promptCalls += 1
          if (promptCalls === 1) throw new Error("fetch failed: ECONNRESET")
          return {}
        },
        async status() { return { data: { parent: { type: "idle" } } } },
        async abort() { return true },
        async delete() { return true },
        async create() { return { data: { id: "unused-verifier" } } },
      },
    }
    const hooks = await recoveryPlugin(root, client)
    await createGoal(hooks)

    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
    await waitFor(async () => {
      const goal = await stateFor(root)
      return goal.status === "active" && goal.infrastructureRecovery?.kind === "continuation_dispatch"
    })
    const recovering = await stateFor(root)
    const stalledBeforeRetry = recovering.stalledTurns
    assert.ok(recovering.infrastructureRecovery.nextRetryAt > 0)

    await waitFor(() => promptCalls === 2)
    const recovered = await stateFor(root)
    assert.equal(recovered.status, "active")
    assert.equal(recovered.stalledTurns, stalledBeforeRetry, "transport recovery must not look like another stalled coding turn")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("recovery never injects a second prompt while OpenCode still owns retry status", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-infra-host-retry-"))
  let parentPrompts = 0
  let liveStatus = "retry"
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
    const hooks = await recoveryPlugin(root, client, { retryWatchdogMs: 1000 })
    await createGoal(hooks)
    await hooks.tool.opencode_goal_complete.execute(
      { summary: "done" },
      { sessionID: "parent", messageID: "executor-current", agent: "build" },
    )

    await new Promise((resolve) => setTimeout(resolve, 70))
    assert.equal(parentPrompts, 0, "provider retry ownership must suppress duplicate Goal continuation")
    liveStatus = "idle"
    await waitFor(() => parentPrompts === 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
