import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCode2GoalsExperimental from "../dist/opencode2/experimental.js"

function fakeV2Context(root) {
  const hooks = new Map()
  const tools = new Map()
  const command = { name: "goal", description: "", template: "$ARGUMENTS", subtask: true }
  const ctx = {
    command: {
      async transform(callback) {
        await callback({
          update(name, updater) {
            assert.equal(name, "goal")
            updater(command)
          },
        })
      },
    },
    tool: {
      async transform(callback) {
        await callback({
          add(name, definition) {
            tools.set(name, definition)
          },
        })
      },
    },
    session: {
      async get({ sessionID }) {
        return { id: sessionID, location: { directory: root } }
      },
      async hook(name, callback) {
        hooks.set(name, callback)
      },
    },
  }
  return { ctx, hooks, tools, command }
}

function commandText(template, args) {
  return template.replace("$ARGUMENTS", args)
}

function requestEvent({ sessionID = "s1", messages, agent = "build" }) {
  return {
    sessionID,
    agent,
    messages,
    tools: {
      opencode_goals_v2_control: { description: "control" },
      opencode_goals_v2_get: { description: "get" },
    },
  }
}

test("V2 control capability is consumed for one command message but a new identical user command can authorize again", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-v2-control-replay-"))
  try {
    const fake = fakeV2Context(root)
    await OpenCode2GoalsExperimental.setup(fake.ctx)

    const requestHook = fake.hooks.get("request")
    const control = fake.tools.get("opencode_goals_v2_control")
    assert.equal(typeof requestHook, "function")
    assert.equal(typeof control?.execute, "function")

    const args = "status"
    const wrapped = commandText(fake.command.template, args)

    const first = requestEvent({
      messages: [{ id: "user-command-1", role: "user", content: wrapped }],
    })
    await requestHook(first)
    assert.ok(first.tools.opencode_goals_v2_control, "the first model request for an authorized /goal command keeps the control tool")

    const firstResult = await control.execute({ arguments: args }, { sessionID: "s1", agent: "build", callID: "call-1" })
    assert.equal(firstResult.output.message, "No active goal.")

    const sameTurnSecondStep = requestEvent({
      messages: [
        { id: "user-command-1", role: "user", content: wrapped },
        { id: "assistant-1", role: "assistant", content: "tool call" },
        { id: "tool-1", role: "tool", content: "No active goal." },
      ],
    })
    await requestHook(sameTurnSecondStep)
    assert.equal(
      sameTurnSecondStep.tools.opencode_goals_v2_control,
      undefined,
      "the same command message must not reauthorize control after the first tool execution",
    )
    await assert.rejects(
      control.execute({ arguments: args }, { sessionID: "s1", agent: "build", callID: "call-replay" }),
      /no matching single-use \/goal command capability/i,
    )

    const newUserCommand = requestEvent({
      messages: [
        { id: "user-command-1", role: "user", content: wrapped },
        { id: "assistant-1", role: "assistant", content: "done" },
        { id: "user-command-2", role: "user", content: wrapped },
      ],
    })
    await requestHook(newUserCommand)
    assert.ok(newUserCommand.tools.opencode_goals_v2_control, "a later user message may intentionally run the same /goal command again")

    const secondResult = await control.execute({ arguments: args }, { sessionID: "s1", agent: "build", callID: "call-2" })
    assert.equal(secondResult.output.message, "No active goal.")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V2 replay guard also distinguishes command turns by user ordinal when host request messages omit IDs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-v2-control-ordinal-"))
  try {
    const fake = fakeV2Context(root)
    await OpenCode2GoalsExperimental.setup(fake.ctx)
    const requestHook = fake.hooks.get("request")
    const control = fake.tools.get("opencode_goals_v2_control")
    const args = "status"
    const wrapped = commandText(fake.command.template, args)

    const first = requestEvent({ messages: [{ role: "user", content: wrapped }] })
    await requestHook(first)
    await control.execute({ arguments: args }, { sessionID: "s1", agent: "build" })

    const sameTurn = requestEvent({
      messages: [
        { role: "user", content: wrapped },
        { role: "assistant", content: "done" },
      ],
    })
    await requestHook(sameTurn)
    assert.equal(sameTurn.tools.opencode_goals_v2_control, undefined)

    const later = requestEvent({
      messages: [
        { role: "user", content: wrapped },
        { role: "assistant", content: "done" },
        { role: "user", content: wrapped },
      ],
    })
    await requestHook(later)
    assert.ok(later.tools.opencode_goals_v2_control)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
