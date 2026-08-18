import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCode2GoalsExperimental from "../dist/opencode2/experimental.js"

function currentOnlyContext(root) {
  const commands = new Map()
  const tools = new Map()
  const hooks = new Map()
  const hookAttempts = []

  const ctx = {
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
    tool: {
      async transform(callback) {
        await callback({
          add(name, definition, options) {
            tools.set(name, { definition, options })
          },
        })
      },
    },
    session: {
      async get({ sessionID }) {
        return { id: sessionID, location: { directory: root } }
      },
      async hook(name, callback) {
        hookAttempts.push(name)
        if (name === "request") throw new Error("legacy request hook is unavailable")
        hooks.set(name, callback)
      },
    },
  }

  return { ctx, commands, tools, hooks, hookAttempts }
}

test("experimental V2 activation requires current context hook and tolerates missing legacy request hook", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-v2-context-hook-"))
  try {
    const host = currentOnlyContext(root)
    const cleanup = await OpenCode2GoalsExperimental.setup(host.ctx)

    assert.equal(typeof host.hooks.get("context"), "function")
    assert.deepEqual(host.hookAttempts, ["context", "request"])
    assert.equal(typeof cleanup, "function")

    const command = host.commands.get("goal")
    assert.equal(typeof command?.template, "string")
    const rawArguments = "status"
    const event = {
      sessionID: "context-session",
      agent: "build",
      system: ["base"],
      tools: {
        opencode_goals_v2_control: { description: "control" },
        opencode_goals_v2_get: { description: "get" },
      },
      messages: [{ role: "user", content: command.template.replace("$ARGUMENTS", rawArguments) }],
    }

    await host.hooks.get("context")(event)
    assert.ok(event.tools.opencode_goals_v2_control, "current context hook must authorize the transformed /goal request")

    const control = host.tools.get("opencode_goals_v2_control")
    const result = await control.definition.execute(
      { arguments: rawArguments },
      { sessionID: "context-session", agent: "build", callID: "context-call" },
    )
    assert.equal(result.output.message, "No active goal.")

    cleanup()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
