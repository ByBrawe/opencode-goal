import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCode2GoalsExperimental, {
  OPENCODE2_DIRECT_LIFECYCLE_ENV,
  executeOpenCode2DirectGoalCommand,
  executeOpenCode2GoalControl,
} from "../dist/opencode2/experimental.js"
import { GoalStore } from "../dist/persistence/store.js"

function fakeContext(directory, options = {}) {
  const commands = new Map()
  const tools = new Map()
  const hooks = new Map()
  const prompts = []
  const synthetics = []
  const interrupts = []
  let agent = options.agent ?? "build"
  let promptSequence = 0
  let commandTransformCalls = 0

  const ctx = {
    app: { name: "opencode", version: options.version ?? "2.0.11", channel: "latest" },
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
        if (options.missingDirectory) return { data: { id: sessionID, agent } }
        return {
          location: { directory },
          data: { id: sessionID, agent },
        }
      },
      async hook(name, callback) {
        hooks.set(name, callback)
      },
      async prompt(input) {
        prompts.push(structuredClone(input))
        if (options.failPromptResume && input.resume === true) {
          throw new Error("synthetic continuation wake failure")
        }
        if (input.id) return { id: input.id }
        promptSequence += 1
        return { id: `msg-direct-${promptSequence}` }
      },
      async synthetic(input) {
        synthetics.push(structuredClone(input))
        return { id: `syn-direct-${synthetics.length}` }
      },
      async interrupt(input) {
        interrupts.push(structuredClone(input))
        return { interrupted: true }
      },
    },
    tool: {
      async transform(callback) {
        await callback({
          add(definition) {
            tools.set(definition.name, definition)
          },
        })
      },
    },
  }

  return {
    ctx,
    commands,
    tools,
    hooks,
    prompts,
    synthetics,
    interrupts,
    commandTransformCalls: () => commandTransformCalls,
    setAgent(value) { agent = value },
  }
}

async function withPreview(fn) {
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

test("V2 direct lifecycle preview stays default-off and exact-host gated", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-v2-direct-gate-"))
  try {
    const disabled = fakeContext(root)
    await OpenCode2GoalsExperimental.setup(disabled.ctx)
    assert.equal(disabled.commandTransformCalls(), 0)
    assert.equal(disabled.commands.size, 0)
    assert.equal(disabled.tools.has("opencode_goals_v2_get"), true)
    assert.equal(disabled.tools.has("opencode_goals_v2_control"), false)

    await withPreview(async () => {
      const unsupported = fakeContext(root, { version: "2.0.12" })
      await assert.rejects(
        OpenCode2GoalsExperimental.setup(unsupported.ctx),
        /proven only on OpenCode 2\.0\.11/i,
      )
      assert.equal(unsupported.commands.size, 0)
      assert.equal(unsupported.tools.size, 0)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V2 direct Build lifecycle uses same host message id and keeps model-visible control read-only", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-v2-direct-build-"))
  try {
    await withPreview(async () => {
      const host = fakeContext(root, { agent: "build" })
      const sessionID = "v2-direct-build"
      const store = new GoalStore(root)
      await OpenCode2GoalsExperimental.setup(host.ctx)

      const command = host.commands.get("goal")
      assert.equal(typeof command?.execute, "function")
      assert.equal(host.tools.has("opencode_goals_v2_control"), false)

      await command.execute({
        sessionID,
        prompt: {
          text: 'ship docs --accept "docs pass" --constraint "preserve API" --max-turns 7',
        },
        delivery: "steer",
      })

      let goal = await store.load(sessionID)
      assert.equal(goal?.objective, "ship docs")
      assert.equal(goal?.status, "active")
      assert.equal(goal?.execution?.agent, "build")
      assert.equal(goal?.budget?.maxTurns, 7)
      assert.deepEqual(goal?.constraints, ["preserve API"])
      assert.equal(host.prompts.length, 2)
      assert.equal(host.prompts[0].resume, false)
      assert.equal(host.prompts[1].resume, true)
      assert.equal(host.prompts[0].id, undefined)
      assert.equal(host.prompts[1].id, "msg-direct-1")
      assert.match(host.prompts[0].text, /ship docs/i)
      assert.equal(host.synthetics.length, 0)

      const modelControl = await executeOpenCode2GoalControl(host.ctx, "pause", {
        sessionID,
        agent: "build",
        messageID: "assistant-routing",
      })
      assert.match(modelControl.content, /model-visible lifecycle control remains read-only/i)
      assert.equal((await store.load(sessionID))?.status, "active")

      const beforeStatus = structuredClone(await store.load(sessionID))
      await command.execute({ sessionID, prompt: { text: "status" }, delivery: "steer" })
      assert.deepEqual(await store.load(sessionID), beforeStatus)
      assert.equal(host.prompts.length, 4, "status relay should use one admitted host message and resume that exact id")
      assert.equal(host.prompts[2].resume, false)
      assert.equal(host.prompts[3].resume, true)
      assert.equal(host.prompts[3].id, "msg-direct-2")
      assert.match(host.prompts[2].text, /Goal: ship docs/)
      assert.equal(host.synthetics.length, 0)

      await command.execute({ sessionID, prompt: { text: "pause" }, delivery: "steer" })
      goal = await store.load(sessionID)
      assert.equal(goal?.status, "paused")
      assert.equal(host.interrupts.length, 1)
      assert.deepEqual(host.interrupts[0], { sessionID, resume: false })
      assert.equal(host.prompts.length, 4, "pause must not dispatch model work")

      await command.execute({ sessionID, prompt: { text: "resume" }, delivery: "steer" })
      goal = await store.load(sessionID)
      assert.equal(goal?.status, "active")
      assert.equal(goal?.execution?.agent, "build")
      assert.equal(host.prompts.length, 6)
      assert.equal(host.prompts[4].resume, false)
      assert.equal(host.prompts[5].resume, true)
      assert.equal(host.prompts[5].id, "msg-direct-3")

      const beforeRevision = goal?.revision
      await command.execute({
        sessionID,
        prompt: { text: 'edit ship docs v2 --constraint "keep compatibility" --max-turns 9' },
        delivery: "queue",
      })
      goal = await store.load(sessionID)
      assert.equal(goal?.objective, "ship docs v2")
      assert.equal(goal?.revision, beforeRevision + 1)
      assert.equal(goal?.execution?.agent, "build")
      assert.deepEqual(goal?.constraints, ["keep compatibility"])
      assert.equal(goal?.budget?.maxTurns, 9)
      assert.equal(host.interrupts.length, 2)
      assert.equal(host.prompts.length, 8)
      assert.equal(host.prompts[6].delivery, "queue")
      assert.equal(host.prompts[7].id, "msg-direct-4")

      const beforeUnsupported = structuredClone(goal)
      const promptsBeforeUnsupported = host.prompts.length
      const syntheticsBeforeUnsupported = host.synthetics.length
      const interruptsBeforeUnsupported = host.interrupts.length
      await assert.rejects(
        command.execute({ sessionID, prompt: { text: "history" }, delivery: "steer" }),
        /does not yet support \/goal history/i,
      )
      assert.deepEqual(await store.load(sessionID), beforeUnsupported)
      assert.equal(host.prompts.length, promptsBeforeUnsupported)
      assert.equal(host.synthetics.length, syntheticsBeforeUnsupported)
      assert.equal(host.interrupts.length, interruptsBeforeUnsupported)

      await command.execute({ sessionID, prompt: { text: "clear" }, delivery: "steer" })
      assert.equal(await store.load(sessionID), null)
      assert.equal(host.interrupts.length, 3)
      assert.equal(host.prompts.length, 8, "clear must not dispatch model work")
      assert.equal(host.synthetics.length, 0)
      const history = await store.history(sessionID, 10)
      assert.equal(history.length, 1)
      assert.equal(history[0].reason, "cleared")
      assert.equal(history[0].goal.objective, "ship docs v2")
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V2 direct Plan lifecycle persists paused and requires Build resume", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-v2-direct-plan-"))
  try {
    await withPreview(async () => {
      const host = fakeContext(root, { agent: "plan" })
      const sessionID = "v2-direct-plan"
      const store = new GoalStore(root)
      await OpenCode2GoalsExperimental.setup(host.ctx)
      const command = host.commands.get("goal")

      await command.execute({
        sessionID,
        prompt: { text: "implement safely" },
        delivery: "steer",
      })
      let goal = await store.load(sessionID)
      assert.equal(goal?.status, "paused")
      assert.equal(goal?.execution?.agent, "plan")
      assert.match(goal?.stopReason ?? "", /restricted agent "plan"/i)
      assert.equal(host.prompts.length, 0, "Plan create must never start implementation")
      assert.equal(host.synthetics.length, 0, "Plan boundary must not queue a deferred synthetic message")

      await command.execute({ sessionID, prompt: { text: "resume" }, delivery: "steer" })
      goal = await store.load(sessionID)
      assert.equal(goal?.status, "paused")
      assert.equal(goal?.execution?.agent, "plan")
      assert.equal(host.prompts.length, 0)
      assert.equal(host.synthetics.length, 0)

      host.setAgent("build")
      await command.execute({ sessionID, prompt: { text: "resume" }, delivery: "steer" })
      goal = await store.load(sessionID)
      assert.equal(goal?.status, "active")
      assert.equal(goal?.execution?.agent, "build")
      assert.equal(host.prompts.length, 2)
      assert.equal(host.prompts[0].resume, false)
      assert.equal(host.prompts[1].resume, true)
      assert.equal(host.prompts[1].id, "msg-direct-1")
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V2 direct lifecycle fails closed on missing host context and pauses after continuation wake failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-v2-direct-failclosed-"))
  try {
    await withPreview(async () => {
      const missingLocation = fakeContext(root, { missingDirectory: true })
      await assert.rejects(
        executeOpenCode2DirectGoalCommand(missingLocation.ctx, {
          sessionID: "missing-location",
          prompt: { text: "ship safely" },
          delivery: "steer",
        }),
        /could not resolve the session location\.directory/i,
      )
      assert.equal(await new GoalStore(root).load("missing-location"), null)

      const missingAgent = fakeContext(root, { agent: "" })
      await assert.rejects(
        executeOpenCode2DirectGoalCommand(missingAgent.ctx, {
          sessionID: "missing-agent",
          prompt: { text: "ship safely" },
          delivery: "steer",
        }),
        /could not resolve the session agent/i,
      )
      assert.equal(await new GoalStore(root).load("missing-agent"), null)

      const transport = fakeContext(root, { agent: "build", failPromptResume: true })
      const sessionID = "dispatch-failure"
      const store = new GoalStore(root)
      await assert.rejects(
        executeOpenCode2DirectGoalCommand(transport.ctx, {
          sessionID,
          prompt: { text: "ship safely" },
          delivery: "steer",
        }),
        /synthetic continuation wake failure/i,
      )
      const paused = await store.load(sessionID)
      assert.equal(paused?.status, "paused")
      assert.match(paused?.stopReason ?? "", /continuation dispatch failed/i)
      assert.equal(transport.prompts.length, 2)
      assert.equal(transport.prompts[0].resume, false)
      assert.equal(transport.prompts[1].resume, true)
      assert.equal(transport.prompts[1].id, "msg-direct-1")
      assert.equal(transport.synthetics.length, 0, "transport failure must not leave a deferred synthetic inbox item")
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
