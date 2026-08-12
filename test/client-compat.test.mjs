import test from "node:test"
import assert from "node:assert/strict"
import { preferSynchronousSessionPrompt } from "../dist/opencode/client-compat.js"

test("current OpenCode clients hide promptAsync from the stable core when bounded sync prompt exists", async () => {
  const session = {
    marker: "session-target",
    prompt() { return this.marker },
    promptAsync() { return "async" },
    create() { return this.marker },
  }
  const client = { session }
  const wrapped = preferSynchronousSessionPrompt(client)

  assert.notEqual(wrapped, client)
  assert.equal(typeof wrapped.session.prompt, "function")
  assert.equal(wrapped.session.prompt(), "session-target", "SDK methods stay bound to their original session object")
  assert.equal(wrapped.session.promptAsync, undefined)
  assert.equal(wrapped.session.create(), "session-target")
  assert.equal(client.session.promptAsync(), "async", "the original SDK client remains untouched for higher-level wrappers")
})

test("async prompt remains available as a compatibility fallback when session.prompt is absent", () => {
  const client = { session: { promptAsync() { return "async-only" } } }
  const wrapped = preferSynchronousSessionPrompt(client)

  assert.equal(wrapped, client)
  assert.equal(wrapped.session.promptAsync(), "async-only")
})

test("clients without promptAsync are returned unchanged", () => {
  const client = { session: { prompt() { return "sync-only" } } }
  assert.equal(preferSynchronousSessionPrompt(client), client)
})
