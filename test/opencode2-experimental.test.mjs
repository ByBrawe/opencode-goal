import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCode2GoalsExperimental, {
  OPENCODE2_EXPERIMENTAL_PLUGIN_ID,
  executeOpenCode2GoalControl,
} from "../dist/opencode2/experimental.js"
import { createGoal } from "../dist/domain/goal.js"
import { GoalStore } from "../dist/persistence/store.js"

function fakeV2Context(directory) {
  const commands = new Map()
  const tools = new Map()
  const hooks = new Map()
  let commandTransformCalls = 0
  return {
    ctx: {
      options: {},
      command: {
        async transform() {
          commandTransformCalls += 1
        },
      },
      session: {
        async get({ sessionID }) {
          return { id: sessionID, location: { directory } }
        },
        async hook(name, callback) {
          hooks.set(name, callback)
        },
      },
      tool: {
        async transform(callback) {
          await callback({
            add(name, definition, options) {
              tools.set(name, { definition, options })
            },
          })
        },
      },
    },
    commands,
    tools,
    hooks,
    commandTransformCalls: () => commandTransformCalls,
  }
}

function requestTools() {
  return {
    opencode_goals_v2_control: { description: "stale control" },
    opencode_goals_v2_get: { description: "get" },
    read: { description: "read" },
  }
}

async function seedGoal(root, sessionID, objective = "ship docs") {
  const store = new GoalStore(root)
  const goal = createGoal({
    sessionID,
    objective,
    acceptance: ["docs match shipped behavior"],
    constraints: ["no unrelated mutation"],
  })
  await store.save(goal)
  return goal
}

async function runHook(host, hookName, {
  sessionID,
  agent = "build",
  text = "ordinary user request",
  system = ["base system"],
} = {}) {
  const event = {
    sessionID,
    agent,
    system,
    tools: requestTools(),
    messages: [{ role: "user", content: text }],
  }
  const hook = host.hooks.get(hookName)
  assert.equal(typeof hook, "function")
  await hook(event)
  return event
}

test("experimental V2 plugin registers read-only inspection without command wrapping or mutating control", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-v2-readonly-"))
  try {
    const host = fakeV2Context(root)
    assert.equal(OpenCode2GoalsExperimental.id, OPENCODE2_EXPERIMENTAL_PLUGIN_ID)
    const cleanup = await OpenCode2GoalsExperimental.setup(host.ctx)

    assert.equal(host.commandTransformCalls(), 0, "read-only V2 adapter must not wrap model-visible command text")
    assert.equal(host.commands.size, 0)
    assert.equal(host.tools.has("opencode_goals_v2_control"), false)
    assert.equal(host.tools.get("opencode_goals_v2_get")?.options?.codemode, false)
    assert.equal(typeof host.tools.get("opencode_goals_v2_get")?.definition?.execute, "function")
    assert.equal(typeof host.hooks.get("context"), "function")
    assert.equal(typeof host.hooks.get("request"), "function")
    assert.equal(typeof cleanup, "function")
    cleanup()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V2 status and contract stay readable while every lifecycle mutation fails closed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-v2-readonly-control-"))
  try {
    const host = fakeV2Context(root)
    const sessionID = "v2-readonly-session"
    const before = await seedGoal(root, sessionID)
    await OpenCode2GoalsExperimental.setup(host.ctx)

    const status = await executeOpenCode2GoalControl(host.ctx, "status", { sessionID, agent: "build" })
    assert.match(status.content, /Goal: ship docs/)
    assert.match(status.content, /Status: active/)

    const contract = await executeOpenCode2GoalControl(host.ctx, "contract", { sessionID, agent: "build" })
    assert.match(contract.content, /OpenCode Goals contract/)
    assert.match(contract.content, /docs match shipped behavior/)
    assert.match(contract.content, /no unrelated mutation/)

    const get = await host.tools.get("opencode_goals_v2_get").definition.execute(
      {},
      { sessionID, agent: "build", messageID: "assistant-read", callID: "call-read" },
    )
    assert.match(get.content, /Goal: ship docs/)

    for (const command of [
      "pause",
      "resume",
      "clear",
      "edit changed objective",
      "ship replacement",
      "budget",
      "history",
      "restore abc123",
      "add queued docs",
      "queue",
      "next",
    ]) {
      const result = await executeOpenCode2GoalControl(host.ctx, command, { sessionID, agent: "build" })
      assert.match(result.content, /read-only on current hosts/i, `${command} must fail closed in V2`)
      assert.match(result.content, /No Goal state was changed/i)
      assert.deepEqual(await new GoalStore(root).load(sessionID), before, `${command} must not mutate Goal state`)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V2 presentation hooks remove stale control and never mutate persisted state, including Plan", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-v2-context-readonly-"))
  try {
    const host = fakeV2Context(root)
    const sessionID = "v2-context-readonly-session"
    const before = await seedGoal(root, sessionID, "ship context")
    await OpenCode2GoalsExperimental.setup(host.ctx)

    const contextEvent = await runHook(host, "context", {
      sessionID,
      agent: "PLAN",
      system: ["base system"],
    })

    assert.equal(contextEvent.tools.opencode_goals_v2_control, undefined)
    assert.ok(contextEvent.tools.opencode_goals_v2_get)
    assert.equal(contextEvent.system[0], "base system")
    assert.match(contextEvent.system[1], /OpenCode Goals experimental V2 persisted state/)
    assert.match(contextEvent.system[1], /Objective: ship context/)
    assert.match(contextEvent.system[1], /read-only until current-host command-origin/i)
    assert.deepEqual(await new GoalStore(root).load(sessionID), before, "Plan/context presentation must not pause or otherwise mutate Goal state")

    const requestEvent = await runHook(host, "request", {
      sessionID,
      agent: "build",
      system: ["base system"],
    })
    assert.equal(requestEvent.tools.opencode_goals_v2_control, undefined)
    assert.match(requestEvent.system[1], /Objective: ship context/)
    assert.deepEqual(await new GoalStore(root).load(sessionID), before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V2 read-only adapter fails closed when the session workspace cannot be resolved", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-v2-location-"))
  try {
    const host = fakeV2Context(root)
    host.ctx.session.get = async () => ({ id: "missing-location" })
    await assert.rejects(
      executeOpenCode2GoalControl(host.ctx, "status", { sessionID: "missing-location", agent: "build" }),
      /could not resolve the session location\.directory/i,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
