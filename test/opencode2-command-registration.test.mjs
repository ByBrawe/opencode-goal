import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCode2GoalsExperimental from "../dist/opencode2/experimental.js"

function strictV2Context(directory, { seedGoal = false } = {}) {
  const commands = new Map()
  if (seedGoal) {
    commands.set("goal", {
      name: "goal",
      description: "project command placeholder",
      template: "$ARGUMENTS",
      subtask: true,
      hints: ["$ARGUMENTS"],
    })
  }

  const tools = new Map()
  const hooks = new Map()
  return {
    ctx: {
      options: {},
      command: {
        async transform(callback) {
          await callback({
            list() {
              return [...commands.values()]
            },
            get(name) {
              return commands.get(name)
            },
            update(name, mutate) {
              const existing = commands.get(name)
              if (!existing) throw new Error(`cannot update missing command: ${name}`)
              mutate(existing)
            },
            remove(name) {
              commands.delete(name)
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

test("V2 setup stays active when the project has not declared a goal command", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-v2-no-command-"))
  try {
    const host = strictV2Context(root)
    await assert.doesNotReject(OpenCode2GoalsExperimental.setup(host.ctx))

    assert.equal(host.commands.has("goal"), false, "a transform hook must not fabricate a new V2 command")
    assert.ok(host.tools.has("opencode_goals_v2_control"), "tool setup should still complete")
    assert.ok(host.tools.has("opencode_goals_v2_get"), "read-only Goal tool should still be available")
    assert.equal(typeof host.hooks.get("request"), "function", "request hook setup should still complete")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V2 setup transforms a project-declared goal command in place", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-v2-seeded-command-"))
  try {
    const host = strictV2Context(root, { seedGoal: true })
    await OpenCode2GoalsExperimental.setup(host.ctx)

    const command = host.commands.get("goal")
    assert.ok(command)
    assert.equal(command.name, "goal")
    assert.match(command.description, /experimental OpenCode 2/i)
    assert.match(command.template, /OpenCode Goals V2 command wrapper/)
    assert.match(command.template, /__OPENCODE_GOALS_V2_COMMAND_[0-9a-f-]+__/i)
    assert.match(command.template, /\$ARGUMENTS/)
    assert.equal(command.subtask, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
