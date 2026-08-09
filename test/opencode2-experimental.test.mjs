import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCode2GoalsExperimental, {
  OPENCODE2_EXPERIMENTAL_PLUGIN_ID,
  executeOpenCode2GoalControl,
} from "../dist/opencode2/experimental.js"
import { GoalStore } from "../dist/persistence/store.js"

function fakeV2Context(directory) {
  const commands = new Map()
  const tools = new Map()
  const hooks = new Map()
  return {
    ctx: {
      options: {},
      command: {
        async transform(callback) {
          await callback({
            update(name, mutate) {
              const draft = commands.get(name) ?? {}
              mutate(draft)
              commands.set(name, draft)
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
  }
}

test("experimental V2 plugin registers an isolated command, direct tools, and context hook", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-v2-"))
  try {
    const host = fakeV2Context(root)
    assert.equal(OpenCode2GoalsExperimental.id, OPENCODE2_EXPERIMENTAL_PLUGIN_ID)
    await OpenCode2GoalsExperimental.setup(host.ctx)

    const command = host.commands.get("goal")
    assert.ok(command)
    assert.match(command.description, /experimental OpenCode 2/i)
    assert.match(command.template, /opencode_goals_v2_control/)
    assert.match(command.template, /\$ARGUMENTS/)
    assert.equal(command.subtask, false)

    assert.equal(host.tools.get("opencode_goals_v2_control")?.options?.codemode, false)
    assert.equal(host.tools.get("opencode_goals_v2_get")?.options?.codemode, false)
    assert.equal(typeof host.hooks.get("context"), "function")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V2 Plan can define a persisted Goal Contract but cannot activate it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-v2-plan-"))
  try {
    const host = fakeV2Context(root)
    const sessionID = "v2-plan-session"
    const created = await executeOpenCode2GoalControl(
      host.ctx,
      'ship auth --success "auth tests pass" --constraint "no new runtime dependency" --check "npm test"',
      { sessionID, agent: "Plan" },
    )

    assert.equal(created.output.status, "paused")
    const stored = await new GoalStore(root).load(sessionID)
    assert.ok(stored)
    assert.equal(stored.status, "paused")
    assert.equal(stored.objective, "ship auth")
    assert.deepEqual(stored.constraints, ["no new runtime dependency"])
    assert.ok(stored.requirements.some((item) => item.source === "acceptance" && item.text === "auth tests pass"))
    assert.ok(stored.requirements.some((item) => item.source === "constraint" && /no new runtime dependency/.test(item.text)))
    assert.ok(stored.requirements.some((item) => item.source === "check" && item.command === "npm test"))

    const refused = await executeOpenCode2GoalControl(host.ctx, "resume", { sessionID, agent: "plan" })
    assert.equal(refused.output.status, "paused")
    assert.match(refused.content, /Switch to Build/i)

    const resumed = await executeOpenCode2GoalControl(host.ctx, "resume", { sessionID, agent: "build" })
    assert.equal(resumed.output.status, "active")
    const active = await new GoalStore(root).load(sessionID)
    assert.equal(active?.status, "active")
    assert.equal(active?.execution?.agent, "build")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("unsupported V2 parity-sensitive controls are explicit and never mutate live Goal state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-v2-unsupported-"))
  try {
    const host = fakeV2Context(root)
    const sessionID = "v2-unsupported-session"
    await executeOpenCode2GoalControl(host.ctx, "ship docs", { sessionID, agent: "build" })
    const before = await new GoalStore(root).load(sessionID)
    assert.ok(before)

    const result = await executeOpenCode2GoalControl(host.ctx, "history", { sessionID, agent: "build" })
    assert.match(result.content, /not enabled yet/i)
    const after = await new GoalStore(root).load(sessionID)
    assert.deepEqual(after, before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V2 context hook injects persisted state and pauses an active Goal selected through Plan", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-v2-context-"))
  try {
    const host = fakeV2Context(root)
    const sessionID = "v2-context-session"
    await executeOpenCode2GoalControl(host.ctx, "ship context --constraint safe", { sessionID, agent: "build" })
    await OpenCode2GoalsExperimental.setup(host.ctx)

    const event = { sessionID, agent: "PLAN", system: ["base system"] }
    await host.hooks.get("context")(event)

    assert.equal(event.system[0], "base system")
    assert.match(event.system[1], /OpenCode Goals experimental V2 persisted state/)
    assert.match(event.system[1], /Objective: ship context/)
    assert.match(event.system[1], /- safe/)

    const stored = await new GoalStore(root).load(sessionID)
    assert.equal(stored?.status, "paused")
    assert.match(stored?.stopReason ?? "", /Plan is a restricted execution agent/i)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V2 adapter fails closed when the session workspace cannot be resolved", async () => {
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
