import test from "node:test"
import assert from "node:assert/strict"
import OpenCode2GoalsExperimental from "../dist/opencode2/experimental.js"

test("experimental V2 uses beta one-object add contract for read-only inspection only", async () => {
  const tools = new Map()
  const hooks = new Map()
  let commandTransformCalls = 0

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
      async transform() {
        commandTransformCalls += 1
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

  assert.equal(commandTransformCalls, 0, "read-only V2 adapter must not depend on command template mutation")
  assert.equal(tools.size, 1)
  assert.equal(tools.has("opencode_goals_v2_control"), false)
  const get = tools.get("opencode_goals_v2_get")
  assert.ok(get)
  assert.equal(get.name, "opencode_goals_v2_get")
  assert.equal(get.codemode, false)
  assert.equal(typeof get.execute, "function")
  assert.equal(typeof hooks.get("context"), "function")
  assert.equal(typeof hooks.get("request"), "function")
  assert.equal(typeof cleanup, "function")
  cleanup()
})
