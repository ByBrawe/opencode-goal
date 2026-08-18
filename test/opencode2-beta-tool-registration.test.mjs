import test from "node:test"
import assert from "node:assert/strict"
import OpenCode2GoalsExperimental from "../dist/opencode2/experimental.js"

test("experimental V2 registers tools through the beta one-object add contract", async () => {
  const commands = new Map()
  const tools = new Map()
  const hooks = new Map()

  function add(definition) {
    assert.equal(arguments.length, 1, "beta tool draft must receive exactly one definition object")
    assert.equal(typeof definition?.name, "string")
    assert.ok(definition.name)
    tools.set(definition.name, definition)
  }
  assert.equal(add.length, 1)

  const ctx = {
    options: { directory: process.cwd() },
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
        await callback({ add })
      },
    },
    session: {
      async get({ sessionID }) {
        return { id: sessionID, location: { directory: process.cwd() } }
      },
      async hook(name, callback) {
        hooks.set(name, callback)
      },
    },
  }

  const cleanup = await OpenCode2GoalsExperimental.setup(ctx)

  assert.equal(tools.size, 2)
  const control = tools.get("opencode_goals_v2_control")
  const get = tools.get("opencode_goals_v2_get")
  assert.ok(control)
  assert.ok(get)
  assert.equal(control.name, "opencode_goals_v2_control")
  assert.equal(get.name, "opencode_goals_v2_get")
  assert.equal(control.codemode, false)
  assert.equal(get.codemode, false)
  assert.equal(typeof control.execute, "function")
  assert.equal(typeof get.execute, "function")
  assert.equal(typeof hooks.get("request"), "function")
  assert.equal(typeof cleanup, "function")
  cleanup()
})
