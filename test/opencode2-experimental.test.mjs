import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCode2GoalsExperimental, {
  OPENCODE2_DIRECT_LIFECYCLE_ENV,
  OPENCODE2_EXPERIMENTAL_PLUGIN_ID,
  executeOpenCode2DirectGoalCommand,
  executeOpenCode2GoalControl,
} from "../dist/opencode2/experimental.js"
import { createGoal } from "../dist/domain/goal.js"
import { GoalStore } from "../dist/persistence/store.js"

function fakeV2Context(directory) {
  const commands = new Map()
  const tools = new Map()
  const hooks = new Map()
  const prompts = []
  const interrupts = []
  let commandTransformCalls = 0
  return {
    ctx: {
      options: {},
      command: {
        async transform(callback) {
          commandTransformCalls += 1
          await callback({
            add(definition) {
              commands.set(definition.name, definition)
            },
          })
        },
      },
      session: {
        async get({ sessionID }) {
          return { id: sessionID, location: { directory } }
        },
        async hook(name, callback) {
          hooks.set(name, callback)
        },
        async prompt(input) {
          prompts.push(input)
          return { id: `prompt-${prompts.length}` }
        },
        async interrupt(input) {
          interrupts.push(input)
          return { interrupted: true }
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
    prompts,
    interrupts,
    commandTransformCalls: () => commandTransformCalls,
  }
}

async function withDirectLifecyclePreview(fn) {
  const key = OPENCODE2_DIRECT_LIFECYCLE_ENV
  const previous = process.env[key]
  process.env[key] = "1"
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
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
      assert.match(result.content, /model-visible lifecycle control remains read-only/i, `${command} must fail closed in V2`)
      assert.match(result.content, /No Goal state was changed/i)
      assert.deepEqual(await new GoalStore(root).load(sessionID), before, `${command} must not mutate Goal state`)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V2 direct lifecycle preview registers only when explicitly enabled", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-v2-direct-register-"))
  try {
    await withDirectLifecyclePreview(async () => {
      const host = fakeV2Context(root)
      await OpenCode2GoalsExperimental.setup(host.ctx)

      assert.equal(host.commandTransformCalls(), 1)
      assert.equal(host.commands.size, 1)
      assert.equal(typeof host.commands.get("goal")?.execute, "function")
      assert.equal(host.tools.has("opencode_goals_v2_control"), false)
      assert.equal(host.tools.has("opencode_goals_v2_get"), true)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V2 direct lifecycle preview refuses activation when the host lacks a command boundary", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-v2-direct-command-capability-"))
  try {
    await withDirectLifecyclePreview(async () => {
      const host = fakeV2Context(root)
      delete host.ctx.command
      await assert.rejects(
        OpenCode2GoalsExperimental.setup(host.ctx),
        /requires command\.transform/i,
      )
      assert.equal(host.tools.size, 0, "preview activation failure must happen before tool registration")
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V2 direct lifecycle preview mutates only through the host-native command boundary", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-v2-direct-lifecycle-"))
  try {
    await withDirectLifecyclePreview(async () => {
      const host = fakeV2Context(root)
      const sessionID = "v2-direct-lifecycle-session"
      const store = new GoalStore(root)
      await OpenCode2GoalsExperimental.setup(host.ctx)
      const command = host.commands.get("goal")
      assert.equal(typeof command?.execute, "function")

      await command.execute({
        sessionID,
        prompt: { text: 'ship docs --accept "docs are correct" --constraint "no unrelated mutation" --max-turns 7' },
        delivery: "steer",
      })

      let goal = await store.load(sessionID)
      assert.equal(goal?.objective, "ship docs")
      assert.equal(goal?.status, "active")
      assert.equal(goal?.budget?.maxTurns, 7)
      assert.deepEqual(goal?.constraints, ["no unrelated mutation"])
      assert.equal(host.prompts.length, 2)
      assert.equal(host.interrupts.length, 0)
      assert.equal(host.prompts[0].sessionID, sessionID)
      assert.match(host.prompts[0].text, /ship docs/i)
      assert.equal(host.prompts[0].metadata?.opencode_goal_v2_direct_command, true)
      assert.equal(host.prompts[0].resume, false)
      assert.equal(host.prompts[1].id, "prompt-1")
      assert.equal(host.prompts[1].resume, true)

      const modelControl = await executeOpenCode2GoalControl(host.ctx, "pause", { sessionID, agent: "build" })
      assert.match(modelControl.content, /model-visible lifecycle control remains read-only/i)
      assert.equal((await store.load(sessionID))?.status, "active", "model-visible control must not mutate even when preview is enabled")

      await command.execute({
        sessionID,
        prompt: { text: "pause" },
        delivery: "steer",
      })
      goal = await store.load(sessionID)
      assert.equal(goal?.status, "paused")
      assert.equal(host.interrupts.length, 1)
      assert.deepEqual(host.interrupts[0], { sessionID, resume: false })
      assert.equal(host.prompts.length, 2, "pause must not dispatch model work")

      await command.execute({
        sessionID,
        prompt: { text: "resume" },
        delivery: "steer",
      })
      goal = await store.load(sessionID)
      assert.equal(goal?.status, "active")
      assert.equal(host.prompts.length, 4)

      const beforeRevision = goal?.revision
      await command.execute({
        sessionID,
        prompt: { text: 'edit ship docs v2 --constraint "preserve API" --max-turns 9' },
        delivery: "queue",
      })
      goal = await store.load(sessionID)
      assert.equal(goal?.objective, "ship docs v2")
      assert.equal(goal?.revision, beforeRevision + 1)
      assert.deepEqual(goal?.constraints, ["preserve API"])
      assert.equal(goal?.budget?.maxTurns, 9)
      assert.equal(host.interrupts.length, 2)
      assert.equal(host.prompts.length, 6)
      assert.equal(host.prompts[4].delivery, "queue")
      assert.equal(host.prompts[5].delivery, "queue")
      assert.equal(host.prompts[5].id, "prompt-5")

      const beforeUnsupported = structuredClone(goal)
      const interruptsBeforeUnsupported = host.interrupts.length
      const promptsBeforeUnsupported = host.prompts.length
      await assert.rejects(
        command.execute({
          sessionID,
          prompt: { text: "history" },
          delivery: "steer",
        }),
        /does not yet support \/goal history/i,
      )
      assert.deepEqual(await store.load(sessionID), beforeUnsupported)
      assert.equal(host.interrupts.length, interruptsBeforeUnsupported)
      assert.equal(host.prompts.length, promptsBeforeUnsupported)

      await command.execute({
        sessionID,
        prompt: { text: "clear" },
        delivery: "steer",
      })
      assert.equal(await store.load(sessionID), null)
      assert.equal(host.interrupts.length, 3)
      assert.equal(host.prompts.length, 6)
      const history = await store.history(sessionID, 10)
      assert.equal(history.length, 1)
      assert.equal(history[0].reason, "cleared")
      assert.equal(history[0].goal.objective, "ship docs v2")
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V2 direct lifecycle preview fails closed before mutation when workspace or host controls are unavailable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-v2-direct-failclosed-"))
  try {
    await withDirectLifecyclePreview(async () => {
      const host = fakeV2Context(root)
      const sessionID = "v2-direct-failclosed-session"
      const before = await seedGoal(root, sessionID)
      host.ctx.session.get = async () => ({ id: sessionID })

      await assert.rejects(
        executeOpenCode2DirectGoalCommand(host.ctx, {
          sessionID,
          prompt: { text: "pause" },
          delivery: "steer",
        }),
        /could not resolve the session location\.directory/i,
      )
      assert.deepEqual(await new GoalStore(root).load(sessionID), before)
      assert.equal(host.interrupts.length, 0)

      host.ctx.session.get = async ({ sessionID: id }) => ({ id, location: { directory: root } })
      const interrupt = host.ctx.session.interrupt
      delete host.ctx.session.interrupt
      await assert.rejects(
        executeOpenCode2DirectGoalCommand(host.ctx, {
          sessionID,
          prompt: { text: "pause" },
          delivery: "steer",
        }),
        /requires session\.interrupt/i,
      )
      assert.deepEqual(await new GoalStore(root).load(sessionID), before)

      host.ctx.session.interrupt = interrupt
      delete host.ctx.session.prompt
      await assert.rejects(
        executeOpenCode2DirectGoalCommand(host.ctx, {
          sessionID: "v2-direct-create-without-prompt",
          prompt: { text: "create should fail before save" },
          delivery: "steer",
        }),
        /requires session\.prompt/i,
      )
      assert.equal(await new GoalStore(root).load("v2-direct-create-without-prompt"), null)
    })
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
    assert.match(contextEvent.system[1], /Model-visible V2 lifecycle mutation remains read-only/i)
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
