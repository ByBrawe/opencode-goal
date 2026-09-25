import test from "node:test"
import assert from "node:assert/strict"
import OpenCode2GoalsExperimental, { OPENCODE2_AUTONOMOUS_ENV, OPENCODE2_DIRECT_LIFECYCLE_ENV } from "../dist/opencode2/experimental.js"

test("V2 kill switch preserves beta one-object read-only registration", async () => {
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

  const previousDirect = process.env[OPENCODE2_DIRECT_LIFECYCLE_ENV]
  const previousAutonomous = process.env[OPENCODE2_AUTONOMOUS_ENV]
  process.env[OPENCODE2_DIRECT_LIFECYCLE_ENV] = "0"
  process.env[OPENCODE2_AUTONOMOUS_ENV] = "0"
  try {
    const cleanup = await OpenCode2GoalsExperimental.setup(ctx)

    assert.equal(commandTransformCalls, 0, "V2 kill switch must retain the read-only beta-host fallback")
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
    await cleanup()
  } finally {
    if (previousDirect === undefined) delete process.env[OPENCODE2_DIRECT_LIFECYCLE_ENV]
    else process.env[OPENCODE2_DIRECT_LIFECYCLE_ENV] = previousDirect
    if (previousAutonomous === undefined) delete process.env[OPENCODE2_AUTONOMOUS_ENV]
    else process.env[OPENCODE2_AUTONOMOUS_ENV] = previousAutonomous
  }
})
