import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCode2GoalsExperimental from "../dist/opencode2/experimental.js"

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

function request(sessionID, messages) {
  return {
    sessionID,
    agent: "build",
    system: ["base"],
    tools: requestTools(),
    messages,
  }
}

test("V2 command capability is not re-authorized on the post-tool model request", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-v2-turn-capability-"))
  try {
    const host = fakeV2Context(root)
    await OpenCode2GoalsExperimental.setup(host.ctx)
    const sessionID = "v2-turn-capability"
    const rawArguments = "status"
    const commandText = commandMessage(host, rawArguments)

    const first = request(sessionID, [{ role: "user", content: commandText }])
    await host.hooks.get("request")(first)
    assert.ok(first.tools.opencode_goals_v2_control, "fresh command request must expose control")

    const control = host.tools.get("opencode_goals_v2_control").definition
    const result = await control.execute(
      { arguments: rawArguments },
      { sessionID, agent: "build", messageID: "assistant-1", callID: "call-1" },
    )
    assert.match(result.content, /No active goal/)

    const second = request(sessionID, [
      { role: "user", content: commandText },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "call-1", toolName: "opencode_goals_v2_control", input: { arguments: rawArguments } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call-1", toolName: "opencode_goals_v2_control", output: result.content }] },
    ])
    await host.hooks.get("request")(second)
    assert.equal(
      second.tools.opencode_goals_v2_control,
      undefined,
      "post-tool dispatch for the same command turn must not mint a second capability",
    )

    await assert.rejects(
      control.execute(
        { arguments: rawArguments },
        { sessionID, agent: "build", messageID: "assistant-2", callID: "call-2" },
      ),
      /no matching single-use \/goal command capability/i,
    )

    const freshSameArguments = request(sessionID, [
      ...second.messages,
      { role: "assistant", content: "done" },
      { role: "user", content: commandText },
    ])
    await host.hooks.get("request")(freshSameArguments)
    assert.ok(
      freshSameArguments.tools.opencode_goals_v2_control,
      "a later identical /goal user turn must receive a fresh capability",
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a mismatched V2 control attempt consumes the pending capability and cannot be corrected in-place", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-v2-mismatch-capability-"))
  try {
    const host = fakeV2Context(root)
    await OpenCode2GoalsExperimental.setup(host.ctx)
    const sessionID = "v2-mismatch-capability"
    const rawArguments = "status"
    const commandText = commandMessage(host, rawArguments)
    const first = request(sessionID, [{ role: "user", content: commandText }])
    await host.hooks.get("request")(first)
    assert.ok(first.tools.opencode_goals_v2_control)

    const control = host.tools.get("opencode_goals_v2_control").definition
    await assert.rejects(
      control.execute(
        { arguments: "contract" },
        { sessionID, agent: "build", messageID: "assistant-bad", callID: "call-bad" },
      ),
      /no matching single-use \/goal command capability/i,
    )

    await assert.rejects(
      control.execute(
        { arguments: rawArguments },
        { sessionID, agent: "build", messageID: "assistant-corrected", callID: "call-corrected" },
      ),
      /no matching single-use \/goal command capability/i,
      "the first control attempt consumes the request-scoped capability even when arguments mismatch",
    )

    const postFailure = request(sessionID, [
      { role: "user", content: commandText },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "call-bad", toolName: "opencode_goals_v2_control", input: { arguments: "contract" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call-bad", toolName: "opencode_goals_v2_control", output: "rejected" }] },
    ])
    await host.hooks.get("request")(postFailure)
    assert.equal(postFailure.tools.opencode_goals_v2_control, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
