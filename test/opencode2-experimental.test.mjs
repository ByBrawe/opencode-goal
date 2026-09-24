import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCode2GoalsExperimental, {
  OPENCODE2_DIRECT_LIFECYCLE_ENV,
  OPENCODE2_EXPERIMENTAL_PLUGIN_ID,
  createOpenCode2DirectLifecycleRuntime,
  executeOpenCode2GoalControl,
  observeOpenCode2LifecycleBoundary,
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
  let promptCounter = 0
  let currentDirectory = directory

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
          return { id: sessionID, location: { directory: currentDirectory } }
        },
        async hook(name, callback) {
          hooks.set(name, callback)
        },
        async prompt(input) {
          const id = input.id ?? `user-message-${++promptCounter}`
          prompts.push({ ...input, returnedID: id })
          return { id }
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
    setDirectory(next) {
      currentDirectory = next
    },
  }
}

function fakeV2PromiseToolContext(directory) {
  const host = fakeV2Context(directory)
  host.ctx.tool.transform = async (callback) => {
    await callback({
      add(definition) {
        host.tools.set(definition.name, {
          definition,
          options: definition.options,
        })
      },
    })
  }
  return host
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
  messageID,
  messages,
  system = ["base system"],
} = {}) {
  const event = {
    sessionID,
    agent,
    system,
    tools: requestTools(),
    messages: messages ?? [{
      ...(messageID ? { id: messageID } : {}),
      role: "user",
      content: text,
    }],
  }
  const hook = host.hooks.get(hookName)
  assert.equal(typeof hook, "function")
  await hook(event)
  return event
}

async function dispatchDirectCommand(host, sessionID, command, delivery = "steer") {
  const definition = host.commands.get("goal")
  assert.equal(typeof definition?.execute, "function")
  const before = host.prompts.length
  await definition.execute({
    sessionID,
    prompt: { text: command },
    delivery,
  })
  const emitted = host.prompts.slice(before)
  const admitted = emitted.find((item) => item.resume === false)
  return {
    emitted,
    messageID: admitted?.returnedID,
  }
}

async function armCapability(host, sessionID, messageID, agent = "build") {
  assert.ok(messageID)
  return await runHook(host, "context", {
    sessionID,
    agent,
    messageID,
    text: "authorized direct goal command",
  })
}

async function consumeCapability(host, sessionID, command, agent = "build") {
  const control = host.tools.get("opencode_goals_v2_control")?.definition
  assert.equal(typeof control?.execute, "function")
  return await control.execute(
    { command },
    { sessionID, agent, messageID: "assistant-message", callID: "call-control" },
  )
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
    assert.equal(typeof host.hooks.get("compaction"), "function")
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

    const currentContextEvent = await runHook(host, "context", {
      sessionID,
      agent: "build",
      system: [{ type: "text", text: "base system" }],
    })
    assert.deepEqual(currentContextEvent.system[0], { type: "text", text: "base system" })
    assert.equal(currentContextEvent.system[1]?.type, "text")
    assert.match(currentContextEvent.system[1]?.text ?? "", /OpenCode Goals experimental V2 persisted state/)
    assert.match(currentContextEvent.system[1]?.text ?? "", /Objective: ship context/)

    const requestEvent = await runHook(host, "request", {
      sessionID,
      agent: "build",
      system: ["base system"],
    })
    assert.equal(requestEvent.tools.opencode_goals_v2_control, undefined)
    assert.match(requestEvent.system[1], /Objective: ship context/)
    assert.deepEqual(await new GoalStore(root).load(sessionID), before)

    const compactionEvent = await runHook(host, "compaction", {
      sessionID,
      agent: "build",
      system: [],
    })
    assert.equal(compactionEvent.tools.opencode_goals_v2_control, undefined, "compaction must never inherit direct mutation authority")
    assert.equal(compactionEvent.system[0]?.type, "text")
    assert.match(compactionEvent.system[0]?.text ?? "", /OpenCode Goals experimental V2 persisted state/)
    assert.match(compactionEvent.system[0]?.text ?? "", /Objective: ship context/)
    assert.deepEqual(await new GoalStore(root).load(sessionID), before, "compaction context injection must stay read-only")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("current OpenCode 2 one-argument ToolEditor registers provider-callable tools through options.codemode", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-v2-current-tool-shape-"))
  try {
    await withDirectLifecyclePreview(async () => {
      const host = fakeV2PromiseToolContext(root)
      await OpenCode2GoalsExperimental.setup(host.ctx)

      const control = host.tools.get("opencode_goals_v2_control")?.definition
      const readOnly = host.tools.get("opencode_goals_v2_get")?.definition
      assert.deepEqual(control?.options, { codemode: false })
      assert.deepEqual(readOnly?.options, { codemode: false })
      assert.equal(control?.codemode, false, "legacy beta hint remains present for compatibility")
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V2 execution terminal events revoke single-execution lifecycle authority", () => {
  const runtime = createOpenCode2DirectLifecycleRuntime()
  const sessionID = "v2-terminal-boundary"
  const seed = (suffix) => {
    const key = `${sessionID}\\u0000message-${suffix}`
    runtime.capabilities.set(key, {
      sessionID,
      messageID: `message-${suffix}`,
      directory: "/tmp/v2-terminal",
      command: "pause",
      canonicalCommand: "{}",
      action: "pause",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      state: "armed",
    })
    runtime.armedBySession.set(sessionID, key)
  }

  seed("started")
  assert.equal(
    observeOpenCode2LifecycleBoundary(runtime, { type: "session.execution.started", data: { sessionID } }),
    undefined,
  )
  assert.equal(runtime.capabilities.size, 1, "execution.started must not revoke the capability before request-time authorization")

  for (const type of [
    "session.execution.succeeded",
    "session.execution.failed",
    "session.execution.interrupted",
  ]) {
    const suffix = type.split(".").at(-1)
    runtime.capabilities.clear()
    runtime.armedBySession.clear()
    seed(suffix)
    assert.equal(observeOpenCode2LifecycleBoundary(runtime, { type, data: { sessionID } }), "execution-terminal")
    assert.equal(runtime.capabilities.size, 0, `${type} must revoke pending/armed capability state`)
    assert.equal(runtime.armedBySession.has(sessionID), false)
  }

  runtime.capabilities.clear()
  runtime.armedBySession.clear()
  const newerKey = `${sessionID}\\u0000message-newer`
  runtime.capabilities.set(newerKey, {
    sessionID,
    messageID: "message-newer",
    directory: "/tmp/v2-terminal",
    command: "pause",
    canonicalCommand: "{}",
    action: "pause",
    createdAt: 2_000,
    expiresAt: 60_000,
    state: "pending",
  })
  assert.equal(
    observeOpenCode2LifecycleBoundary(runtime, {
      type: "session.execution.succeeded",
      created: 1_000,
      data: { sessionID },
    }),
    "execution-terminal",
  )
  assert.equal(runtime.capabilities.has(newerKey), true, "a late prior terminal event must not revoke newer command authority")

  assert.equal(
    observeOpenCode2LifecycleBoundary(runtime, {
      type: "session.execution.interrupted",
      created: 3_000,
      data: { sessionID },
    }),
    "execution-terminal",
  )
  assert.equal(runtime.capabilities.has(newerKey), false, "a terminal event created after the capability must revoke it")

  seed("deleted")
  assert.equal(
    observeOpenCode2LifecycleBoundary(runtime, { type: "session.deleted", data: { sessionID } }),
    "session-deleted",
  )
  assert.equal(runtime.capabilities.size, 0)
  assert.equal(runtime.armedBySession.has(sessionID), false)
})

test("V2 direct lifecycle preview registers host command and mutating tool only when explicitly enabled", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-v2-capability-register-"))
  try {
    await withDirectLifecyclePreview(async () => {
      const host = fakeV2Context(root)
      await OpenCode2GoalsExperimental.setup(host.ctx)

      assert.equal(host.commandTransformCalls(), 1)
      assert.equal(typeof host.commands.get("goal")?.execute, "function")
      assert.equal(typeof host.tools.get("opencode_goals_v2_control")?.definition?.execute, "function")
      assert.equal(typeof host.tools.get("opencode_goals_v2_get")?.definition?.execute, "function")
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("direct lifecycle command mints host-message capability without persisting until the one-use tool consumes it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-v2-capability-create-"))
  try {
    await withDirectLifecyclePreview(async () => {
      const host = fakeV2Context(root)
      const sessionID = "v2-capability-create"
      const command = 'ship docs --accept "docs are correct" --constraint "no unrelated mutation" --max-turns 7'
      await OpenCode2GoalsExperimental.setup(host.ctx)

      const dispatched = await dispatchDirectCommand(host, sessionID, command)
      assert.ok(dispatched.messageID)
      assert.equal(dispatched.emitted.length, 2)
      assert.equal(dispatched.emitted[0].resume, false)
      assert.equal(dispatched.emitted[1].resume, true)
      assert.equal(dispatched.emitted[1].id, dispatched.messageID)
      assert.equal(await new GoalStore(root).load(sessionID), null, "direct callback must not persist Goal state")

      const auxiliary = await runHook(host, "context", {
        sessionID,
        messages: [],
      })
      assert.equal(auxiliary.tools.opencode_goals_v2_control, undefined, "auxiliary context without a user message must hide control")

      const context = await armCapability(host, sessionID, dispatched.messageID)
      assert.ok(context.tools.opencode_goals_v2_control, "authorized request must expose the mutating tool after auxiliary context")
      assert.match(context.system.join("\n"), /host-authenticated lifecycle command/i)
      assert.match(context.system.join("\n"), /exactly once/i)

      const result = await consumeCapability(host, sessionID, command)
      assert.match(result.content, /single-use capability is consumed/i)
      const goal = await new GoalStore(root).load(sessionID)
      assert.equal(goal?.objective, "ship docs")
      assert.equal(goal?.status, "active")
      assert.equal(goal?.budget?.maxTurns, 7)
      assert.deepEqual(goal?.constraints, ["no unrelated mutation"])

      await assert.rejects(
        consumeCapability(host, sessionID, command),
        /not armed/i,
        "replay must fail after the first tool invocation",
      )

      const continuation = await armCapability(host, sessionID, dispatched.messageID)
      assert.equal(continuation.tools.opencode_goals_v2_control, undefined, "post-tool continuation must not re-expose mutating control")
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("mismatched lifecycle arguments consume the capability before persistence and cannot be retried", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-v2-capability-mismatch-"))
  try {
    await withDirectLifecyclePreview(async () => {
      const host = fakeV2Context(root)
      const sessionID = "v2-capability-mismatch"
      const command = 'ship authorized --constraint "preserve api"'
      await OpenCode2GoalsExperimental.setup(host.ctx)

      const dispatched = await dispatchDirectCommand(host, sessionID, command)
      await armCapability(host, sessionID, dispatched.messageID)

      await assert.rejects(
        consumeCapability(host, sessionID, "ship escalated --max-turns 999"),
        /arguments do not match/i,
      )
      assert.equal(await new GoalStore(root).load(sessionID), null)

      await assert.rejects(
        consumeCapability(host, sessionID, command),
        /not armed/i,
        "a mismatched first attempt must revoke the one-use capability",
      )
      assert.equal(await new GoalStore(root).load(sessionID), null)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("ordinary prompt text and Plan contexts cannot arm or reuse lifecycle mutation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-v2-capability-plan-"))
  try {
    await withDirectLifecyclePreview(async () => {
      const host = fakeV2Context(root)
      const sessionID = "v2-capability-plan"
      await OpenCode2GoalsExperimental.setup(host.ctx)

      const ordinary = await runHook(host, "context", {
        sessionID,
        messageID: "ordinary-user",
        text: "/goal ship spoofed",
      })
      assert.equal(ordinary.tools.opencode_goals_v2_control, undefined)
      assert.equal(await new GoalStore(root).load(sessionID), null)

      const dispatched = await dispatchDirectCommand(host, sessionID, "ship plan forbidden")
      const plan = await armCapability(host, sessionID, dispatched.messageID, "PLAN")
      assert.equal(plan.tools.opencode_goals_v2_control, undefined)

      const laterBuild = await armCapability(host, sessionID, dispatched.messageID, "build")
      assert.equal(laterBuild.tools.opencode_goals_v2_control, undefined, "Plan exposure attempt must revoke the capability")
      await assert.rejects(
        consumeCapability(host, sessionID, "ship plan forbidden"),
        /not armed/i,
      )
      assert.equal(await new GoalStore(root).load(sessionID), null)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("workspace changes fail closed after capability consumption and before Goal persistence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-v2-capability-location-"))
  const moved = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-v2-capability-location-moved-"))
  try {
    await withDirectLifecyclePreview(async () => {
      const host = fakeV2Context(root)
      const sessionID = "v2-capability-location"
      const command = "ship bound workspace"
      await OpenCode2GoalsExperimental.setup(host.ctx)

      const dispatched = await dispatchDirectCommand(host, sessionID, command)
      await armCapability(host, sessionID, dispatched.messageID)
      host.setDirectory(moved)

      await assert.rejects(
        consumeCapability(host, sessionID, command),
        /workspace changed before persistence/i,
      )
      assert.equal(await new GoalStore(root).load(sessionID), null)
      assert.equal(await new GoalStore(moved).load(sessionID), null)

      await assert.rejects(
        consumeCapability(host, sessionID, command),
        /not armed/i,
      )
    })
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(moved, { recursive: true, force: true })
  }
})

test("authorized capability applies create pause resume edit and clear with one fresh host identity per mutation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-v2-capability-lifecycle-"))
  try {
    await withDirectLifecyclePreview(async () => {
      const host = fakeV2Context(root)
      const sessionID = "v2-capability-lifecycle"
      const store = new GoalStore(root)
      await OpenCode2GoalsExperimental.setup(host.ctx)

      const apply = async (command) => {
        const dispatched = await dispatchDirectCommand(host, sessionID, command)
        assert.ok(dispatched.messageID)
        const context = await armCapability(host, sessionID, dispatched.messageID)
        assert.ok(context.tools.opencode_goals_v2_control)
        return await consumeCapability(host, sessionID, command)
      }

      await apply('ship preview --constraint "no spoof mutation" --max-turns 7')
      let goal = await store.load(sessionID)
      assert.equal(goal?.objective, "ship preview")
      assert.equal(goal?.status, "active")

      await apply("pause")
      goal = await store.load(sessionID)
      assert.equal(goal?.status, "paused")
      assert.ok(host.interrupts.some((item) => item.sessionID === sessionID && item.resume === false))

      await apply("resume")
      goal = await store.load(sessionID)
      assert.equal(goal?.status, "active")

      const beforeRevision = goal.revision
      await apply('edit ship preview revised --constraint "preserve API" --max-turns 9')
      goal = await store.load(sessionID)
      assert.equal(goal?.objective, "ship preview revised")
      assert.equal(goal?.revision, beforeRevision + 1)
      assert.equal(goal?.budget?.maxTurns, 9)
      assert.deepEqual(goal?.constraints, ["preserve API"])

      const goalID = goal.id
      await apply("clear")
      assert.equal(await store.load(sessionID), null)
      const history = await store.history(sessionID, 10)
      assert.equal(history.length, 1)
      assert.equal(history[0].reason, "cleared")
      assert.equal(history[0].goal.id, goalID)
    })
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
