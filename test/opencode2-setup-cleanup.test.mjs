import test from "node:test"
import assert from "node:assert/strict"
import plugin from "../dist/opencode2/experimental.js"

function host(failure) {
  let release = () => {}
  let signal
  let stopped = 0
  const sentinel = new Error(`setup rejected at ${failure}`)
  const ctx = {
    options: {},
    session: {
      get: async ({ sessionID }) => ({ id: sessionID, location: { directory: process.cwd() } }),
      hook: async () => {},
      prompt: async () => { throw new Error("cleanup must not submit a prompt") },
    },
    command: {
      transform: async (edit) => {
        if (failure === "command") throw sentinel
        edit({ add() {} })
      },
    },
    tool: {
      transform: async (edit) => {
        if (failure === "tool") throw sentinel
        edit({ add(definition) {} })
      },
    },
    event: {
      subscribe(input) {
        signal = input.signal
        return (async function* () {
          try {
            await new Promise((resolve) => {
              release = resolve
              if (signal.aborted) resolve()
              else signal.addEventListener("abort", resolve, { once: true })
            })
          } finally { stopped++ }
        })()
      },
    },
  }
  return { ctx, sentinel, signal: () => signal, stopped: () => stopped, release: () => release() }
}

for (const failure of ["command", "tool"]) {
  test(`failed native ${failure} registration aborts and drains its event subscription`, async () => {
    const fixture = host(failure)
    try {
      await assert.rejects(plugin.setup(fixture.ctx), (error) => error === fixture.sentinel)
      assert.equal(fixture.signal()?.aborted, true, "a failed setup must not leave its public event subscription alive")
      assert.equal(fixture.stopped(), 1, "rollback must finish owned event cleanup before rejecting setup")
    } finally { fixture.release() }
  })
}

test("native cleanup is shared, repeatable and waits for subscription teardown", async () => {
  const fixture = host()
  const dispose = await plugin.setup(fixture.ctx)
  try {
    const first = dispose()
    const second = dispose()
    assert.equal(first, second, "concurrent unload must share one cleanup operation")
    assert.equal(fixture.signal()?.aborted, true)
    await first
    assert.equal(fixture.stopped(), 1)
    await dispose()
    assert.equal(fixture.stopped(), 1)
  } finally { fixture.release(); await dispose() }
})
