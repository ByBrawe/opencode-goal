import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCode2GoalsExperimental, {
  OPENCODE2_AUTONOMOUS_ENV,
  OPENCODE2_DIRECT_LIFECYCLE_ENV,
  OPENCODE2_EXPERIMENTAL_PLUGIN_ID,
  createOpenCode2DirectLifecycleRuntime,
  executeOpenCode2GoalControl,
  observeOpenCode2AuthorityBoundary,
} from "../dist/opencode2/experimental.js"
import { createOpenCode2CompactionBoundaryRuntime } from "../dist/opencode2/compaction-boundary.js"
import { createGoal } from "../dist/domain/goal.js"
import { GoalStore } from "../dist/persistence/store.js"
import { GoalSequenceStore } from "../dist/persistence/sequence-store.js"

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

function fakeV2EventContext(directory) {
  const host = fakeV2Context(directory)
  const queued = []
  const waiters = []

  host.ctx.event = {
    subscribe({ signal } = {}) {
      return {
        [Symbol.asyncIterator]() { return this },
        next() {
          if (signal?.aborted) return Promise.resolve({ done: true, value: undefined })
          if (queued.length) return Promise.resolve({ done: false, value: queued.shift() })
          return new Promise((resolve) => {
            const waiter = { resolve }
            waiters.push(waiter)
            signal?.addEventListener("abort", () => {
              const index = waiters.indexOf(waiter)
              if (index >= 0) waiters.splice(index, 1)
              resolve({ done: true, value: undefined })
            }, { once: true })
          })
        },
      }
    },
  }

  host.emitEvent = async (event) => {
    const waiter = waiters.shift()
    if (waiter) waiter.resolve({ done: false, value: event })
    else queued.push(event)
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return host
}

async function waitForValue(predicate, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${message}`)
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

async function withAutonomousPreview(fn) {
  const directKey = OPENCODE2_DIRECT_LIFECYCLE_ENV
  const autonomousKey = OPENCODE2_AUTONOMOUS_ENV
  const previousDirect = process.env[directKey]
  const previousAutonomous = process.env[autonomousKey]
  process.env[directKey] = "1"
  process.env[autonomousKey] = "1"
  try {
    return await fn()
  } finally {
    if (previousDirect === undefined) delete process.env[directKey]
    else process.env[directKey] = previousDirect
    if (previousAutonomous === undefined) delete process.env[autonomousKey]
    else process.env[autonomousKey] = previousAutonomous
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
    assert.match(contract.content, /Goal Contract/)
    assert.match(contract.content, /docs match shipped behavior/)
    assert.match(contract.content, /no unrelated mutation/)

    const get = await host.tools.get("opencode_goals_v2_get").definition.execute(
      {},
      { sessionID, agent: "build", messageID: "assistant-read", callID: "call-read" },
    )
    assert.match(get.content, /Goal: ship docs/)

    for (const [command, expected] of [
      ["budget", /Budget:/],
      ["history", /No archived goals|Archived goals/],
      ["audit", /Goal Audit/],
      ["doctor", /Goal storage doctor:/],
      ["list", /Project Goal snapshots/],
      ["queue", /Goal Sequence/],
    ]) {
      const result = await executeOpenCode2GoalControl(host.ctx, command, { sessionID, agent: "build" })
      assert.match(result.content, expected, `${command} should expose the shared V1 read-only view`)
      assert.deepEqual(await new GoalStore(root).load(sessionID), before, `${command} read must not mutate Goal state`)
    }

    for (const command of [
      "pause",
      "resume",
      "clear",
      "edit changed objective",
      "ship replacement",
      "budget --max-turns 9",
      "history prune --keep 1",
      "restore abc123",
      "add queued docs",
      "queue clear",
      "queue remove abc123",
      "queue move abc123 1",
      "next",
    ]) {
      const result = await executeOpenCode2GoalControl(host.ctx, command, { sessionID, agent: "build" })
      assert.match(result.content, /model-visible lifecycle control remains read-only/i, `${command} must fail closed without host command authority`)
      assert.match(result.content, /No Goal state was changed/i)
      assert.deepEqual(await new GoalStore(root).load(sessionID), before, `${command} must not mutate Goal state`)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V2 host-native admin mutations do not depend on lifecycle control capability", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-v2-host-admin-"))
  try {
    await withDirectLifecyclePreview(async () => {
      const host = fakeV2Context(root)
      const sessionID = "v2-host-admin-session"
      const store = new GoalStore(root)
      await seedGoal(root, sessionID, "host-native admin parity")
      await OpenCode2GoalsExperimental.setup(host.ctx)

      const budgetDispatch = await dispatchDirectCommand(host, sessionID, "budget --max-turns 9")
      assert.equal(budgetDispatch.messageID, undefined, "admin mutation must not admit a lifecycle capability message")
      assert.equal((await store.load(sessionID))?.budget.maxTurns, 9)
      assert.ok(budgetDispatch.emitted.every((item) => item.resume !== false), "admin presentation must stay read-only")

      const presentationMessageID = budgetDispatch.emitted.at(-1)?.returnedID
      if (presentationMessageID) {
        const event = await armCapability(host, sessionID, presentationMessageID)
        assert.equal(event.tools.opencode_goals_v2_control, undefined, "admin presentation cannot mint lifecycle authority")
      }

      await store.clear(sessionID)
      assert.equal(await store.load(sessionID), null)
      const historyBefore = await store.history(sessionID, 500)
      assert.ok(historyBefore.length >= 1)

      // Storage/admin mutations must not require a model/provider presentation
      // surface after host command registration.
      host.ctx.session.prompt = undefined

      const pruneDispatch = await dispatchDirectCommand(host, sessionID, "history prune --keep 1")
      assert.equal(pruneDispatch.messageID, undefined, "history prune must remain host-native without a live Goal")
      assert.deepEqual(pruneDispatch.emitted, [])
      assert.equal((await store.history(sessionID, 500)).length, 1)

      const queueDispatch = await dispatchDirectCommand(host, sessionID, "add queued without live goal")
      assert.equal(queueDispatch.messageID, undefined)
      assert.deepEqual(queueDispatch.emitted, [])
      assert.equal((await new GoalSequenceStore(root).load(sessionID)).items.length, 1)
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

test("V2 authority boundary binds direct capabilities to ordered execution generations", () => {
  const runtime = createOpenCode2DirectLifecycleRuntime()
  const compaction = createOpenCode2CompactionBoundaryRuntime()
  const sessionID = "v2-authority-boundary"

  const seed = (messageID, executionGeneration, state = "armed") => {
    const key = `${sessionID}\u0000${messageID}`
    runtime.capabilities.set(key, {
      sessionID,
      messageID,
      directory: "/tmp/v2-authority",
      command: "pause",
      canonicalCommand: "{}",
      action: "pause",
      createdAt: 1_000,
      expiresAt: 999_999,
      executionGeneration,
      state,
    })
    if (state === "armed") runtime.armedBySession.set(sessionID, key)
    return key
  }

  assert.equal(
    observeOpenCode2AuthorityBoundary(runtime, compaction, { type: "session.execution.started", data: { sessionID } }),
    "execution-started",
  )
  assert.equal(runtime.executionGenerationBySession.get(sessionID), 1)

  const newerPending = seed("generation-2", 2, "pending")
  assert.equal(
    observeOpenCode2AuthorityBoundary(runtime, compaction, { type: "session.execution.succeeded", data: { sessionID } }),
    "execution-terminal",
  )
  assert.equal(
    runtime.capabilities.has(newerPending),
    true,
    "a delayed generation-1 terminal must not revoke authority bound to generation 2",
  )

  assert.equal(
    observeOpenCode2AuthorityBoundary(runtime, compaction, { type: "session.execution.started", data: { sessionID } }),
    "execution-started",
  )
  assert.equal(runtime.executionGenerationBySession.get(sessionID), 2)
  assert.equal(
    observeOpenCode2AuthorityBoundary(runtime, compaction, { type: "session.execution.interrupted", data: { sessionID } }),
    "execution-terminal",
  )
  assert.equal(runtime.capabilities.has(newerPending), false, "generation-2 terminal must revoke generation-2 authority")

  assert.equal(
    observeOpenCode2AuthorityBoundary(runtime, compaction, { type: "session.compaction.started", data: { sessionID } }),
    undefined,
  )
  assert.equal(
    observeOpenCode2AuthorityBoundary(runtime, compaction, { type: "session.execution.started", data: { sessionID } }),
    "execution-started",
  )
  assert.equal(runtime.executionGenerationBySession.get(sessionID), 3)

  const afterCompaction = seed("generation-4", 4)
  assert.equal(
    observeOpenCode2AuthorityBoundary(runtime, compaction, { type: "session.compaction.ended", data: { sessionID } }),
    undefined,
  )
  assert.equal(
    observeOpenCode2AuthorityBoundary(runtime, compaction, { type: "session.execution.succeeded", data: { sessionID } }),
    "compaction-execution",
  )
  assert.equal(
    runtime.capabilities.has(afterCompaction),
    true,
    "compaction execution terminal must not revoke authority for the next direct execution",
  )

  assert.equal(
    observeOpenCode2AuthorityBoundary(runtime, compaction, { type: "session.execution.started", data: { sessionID } }),
    "execution-started",
  )
  assert.equal(runtime.executionGenerationBySession.get(sessionID), 4)
  assert.equal(
    observeOpenCode2AuthorityBoundary(runtime, compaction, { type: "session.execution.failed", data: { sessionID } }),
    "execution-terminal",
  )
  assert.equal(runtime.capabilities.has(afterCompaction), false)

  seed("deleted", 5)
  assert.equal(
    observeOpenCode2AuthorityBoundary(runtime, compaction, { type: "session.deleted", data: { sessionID } }),
    "session-deleted",
  )
  assert.equal(runtime.capabilities.size, 0)
  assert.equal(runtime.armedBySession.has(sessionID), false)
  assert.equal(runtime.executionGenerationBySession.has(sessionID), false)
  assert.equal(compaction.sessions.has(sessionID), false)
})

test("V2 autonomous coordinator counts only exact owned continuation executions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-v2-autonomous-owned-"))
  try {
    await withAutonomousPreview(async () => {
      const host = fakeV2EventContext(root)
      const sessionID = "v2-autonomous-owned"
      const store = new GoalStore(root)
      const cleanup = await OpenCode2GoalsExperimental.setup(host.ctx)

      const dispatched = await dispatchDirectCommand(host, sessionID, "ship autonomous parity")
      assert.ok(dispatched.messageID)
      await armCapability(host, sessionID, dispatched.messageID)
      await host.emitEvent({ type: "session.execution.started", data: { sessionID } })
      await consumeCapability(host, sessionID, "ship autonomous parity")

      let goal = await store.load(sessionID)
      assert.equal(goal?.status, "active")
      assert.equal(goal?.stalledTurns, 0)

      await host.emitEvent({ type: "session.execution.succeeded", data: { sessionID } })
      const kickoff = await waitForValue(
        () => host.prompts.find((item) =>
          item.resume === false
          && item.metadata?.opencode_goal_v2_source === "kickoff"
        ),
        "host-admitted V2 Goal kickoff continuation",
      )
      goal = await store.load(sessionID)
      assert.equal(goal?.stalledTurns, 0, "the lifecycle command execution must not count as a Goal work turn")

      let current = kickoff
      for (const expectedStalls of [1, 2, 3]) {
        await runHook(host, "context", {
          sessionID,
          agent: "build",
          messageID: current.returnedID,
          text: "host-admitted Goal continuation",
        })
        await host.emitEvent({ type: "session.execution.started", data: { sessionID } })
        await host.emitEvent({ type: "session.execution.succeeded", data: { sessionID } })

        goal = await waitForValue(async () => {
          const latest = await store.load(sessionID)
          return latest?.stalledTurns === expectedStalls ? latest : null
        }, `persisted V2 Goal stalledTurns=${expectedStalls}`)

        if (expectedStalls < 3) {
          current = await waitForValue(
            () => host.prompts.find((item) =>
              item.resume === false
              && item.returnedID !== current.returnedID
              && item.metadata?.opencode_goal_v2_source === "execution"
            ),
            `host-admitted Goal continuation after stalled turn ${expectedStalls}`,
          )
          assert.equal(goal.status, "active")
        }
      }

      assert.equal(goal.status, "paused")
      assert.match(goal.stopReason ?? "", /3 continuation turns without host-observed progress/)

      const admittedAutonomous = host.prompts.filter((item) =>
        item.resume === false
        && item.metadata?.opencode_goal_v2_autonomous === true
      )
      assert.equal(admittedAutonomous.length, 3, "kickoff plus two active boundaries must admit exactly three Goal work turns")

      await new Promise((resolve) => setTimeout(resolve, 25))
      assert.equal(
        host.prompts.filter((item) => item.resume === false && item.metadata?.opencode_goal_v2_autonomous === true).length,
        3,
        "the paused third Goal turn must not admit a fourth continuation",
      )

      await cleanup()
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V2 completed Goal terminal auto-promotes exactly one queued Goal and transfers continuation ownership", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-v2-sequence-auto-"))
  try {
    await withAutonomousPreview(async () => {
      const host = fakeV2EventContext(root)
      const sessionID = "v2-sequence-auto"
      const store = new GoalStore(root)
      const sequence = new GoalSequenceStore(root)
      const cleanup = await OpenCode2GoalsExperimental.setup(host.ctx)

      const dispatched = await dispatchDirectCommand(host, sessionID, "ship first queued stage")
      await armCapability(host, sessionID, dispatched.messageID)
      await host.emitEvent({ type: "session.execution.started", data: { sessionID } })
      await consumeCapability(host, sessionID, "ship first queued stage")

      await host.emitEvent({ type: "session.execution.succeeded", data: { sessionID } })
      const kickoff = await waitForValue(
        () => host.prompts.find((item) =>
          item.resume === false
          && item.metadata?.opencode_goal_v2_source === "kickoff"
        ),
        "initial Goal kickoff",
      )

      const queued = await sequence.enqueue(sessionID, { objective: "ship second queued stage" })
      const queuedID = queued.item.id

      await runHook(host, "context", {
        sessionID,
        agent: "build",
        messageID: kickoff.returnedID,
        text: "host-admitted first Goal work turn",
      })
      await host.emitEvent({ type: "session.execution.started", data: { sessionID } })

      const current = await store.load(sessionID)
      assert.ok(current)
      await store.save({
        ...current,
        status: "completed",
        completionSummary: "first queued stage completed",
        updatedAt: Date.now(),
      })

      await host.emitEvent({ type: "session.execution.succeeded", data: { sessionID } })

      const promoted = await waitForValue(async () => {
        const goal = await store.load(sessionID)
        const queuedState = await sequence.load(sessionID)
        return goal?.id === queuedID && goal.status === "active" && queuedState.items.length === 0 ? goal : null
      }, "automatic queued Goal promotion and queue settlement")
      assert.equal(promoted.objective, "ship second queued stage")
      assert.equal((await sequence.load(sessionID)).items.length, 0)

      const sequencePrompt = await waitForValue(
        () => host.prompts.find((item) =>
          item.resume === false
          && item.metadata?.opencode_goal_v2_source === "sequence"
        ),
        "sequence-owned V2 continuation",
      )
      assert.equal(sequencePrompt.metadata?.opencode_goal_id, queuedID)

      const countBeforeDuplicate = host.prompts.filter((item) =>
        item.resume === false
        && item.metadata?.opencode_goal_v2_source === "sequence"
      ).length
      await host.emitEvent({ type: "session.execution.succeeded", data: { sessionID } })
      await new Promise((resolve) => setTimeout(resolve, 25))
      assert.equal(
        host.prompts.filter((item) =>
          item.resume === false
          && item.metadata?.opencode_goal_v2_source === "sequence"
        ).length,
        countBeforeDuplicate,
        "duplicate terminal without the consumed owner must not promote or dispatch again",
      )

      await cleanup()
    })
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })
  }
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
