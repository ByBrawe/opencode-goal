import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCode2GoalsExperimental from "../dist/opencode2/experimental.js"
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

function requestTools() {
  return {
    opencode_goals_v2_control: { description: "control" },
    opencode_goals_v2_get: { description: "get" },
    read: { description: "read" },
  }
}

function commandMessage(host, rawArguments) {
  const template = host.commands.get("goal")?.template
  assert.equal(typeof template, "string")
  return template.replace("$ARGUMENTS", () => rawArguments)
}

async function request(host, sessionID, messages, agent = "build") {
  const event = {
    sessionID,
    agent,
    system: ["base system"],
    tools: requestTools(),
    messages,
  }
  const hook = host.hooks.get("context") ?? host.hooks.get("request")
  assert.equal(typeof hook, "function")
  await hook(event)
  return event
}

test("V2 /goal control capability is not re-armed after tool traffic in the same command turn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-v2-replay-"))
  try {
    const host = fakeV2Context(root)
    await OpenCode2GoalsExperimental.setup(host.ctx)
    const sessionID = "v2-replay-session"
    const rawArguments = "ship docs"
    const transformed = commandMessage(host, rawArguments)

    const initial = await request(host, sessionID, [
      { role: "user", content: transformed },
    ])
    assert.ok(initial.tools.opencode_goals_v2_control, "initial transformed /goal request must retain control")

    const control = host.tools.get("opencode_goals_v2_control").definition
    await control.execute(
      { arguments: rawArguments },
      { sessionID, agent: "build", messageID: "assistant-command", callID: "call-control-1" },
    )
    const afterFirst = await new GoalStore(root).load(sessionID)
    assert.equal(afterFirst?.objective, "ship docs")

    const followup = await request(host, sessionID, [
      { role: "user", content: transformed },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call-control-1", toolName: "opencode_goals_v2_control", input: { arguments: rawArguments } }],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "call-control-1", toolName: "opencode_goals_v2_control", output: { type: "text", value: "created" } }],
      },
    ])

    assert.equal(
      followup.tools.opencode_goals_v2_control,
      undefined,
      "model redispatch after the control result must not expose or re-arm the single-use control capability",
    )
    await assert.rejects(
      control.execute(
        { arguments: rawArguments },
        { sessionID, agent: "build", messageID: "assistant-replay", callID: "call-control-replay" },
      ),
      /no matching single-use \/goal command capability/i,
    )
    assert.deepEqual(await new GoalStore(root).load(sessionID), afterFirst)

    const freshStatus = commandMessage(host, "status")
    const nextTurn = await request(host, sessionID, [
      { role: "user", content: transformed },
      { role: "assistant", content: "created" },
      { role: "user", content: freshStatus },
    ])
    assert.ok(nextTurn.tools.opencode_goals_v2_control, "a later fresh /goal user turn must receive a new capability")
    const status = await control.execute(
      { arguments: "status" },
      { sessionID, agent: "build", messageID: "assistant-status", callID: "call-control-status" },
    )
    assert.match(status.content, /Goal: ship docs/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
