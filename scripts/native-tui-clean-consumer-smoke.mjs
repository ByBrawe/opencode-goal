import assert from "node:assert/strict"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import plugin from "@bybrawe/opencode-goal/tui"

// This file runs only after a fresh strict npm installation of the packed
// candidate into a *different* directory. None of the checkout's dev
// dependencies should resolve from this consumer location.
let slot
let listener
let unregistered = 0
let unsubscribed = 0
const requests = []
const [selected, select] = createSignal("ses_first")
const project = (id) => "/remote/project/" + id

const ctx = {
  client: { rpc: (definition) => {
    assert.equal(definition.id, "opencode-goal-status")
    return { read: async ({ sessionID }, options) => {
      requests.push({ sessionID, location: options.location })
      return {
        schemaVersion: 1, sessionID,
        directory: options.location.directory,
        text: "OpenCode Goals\nACTIVE " + sessionID,
      }
    } }
  } },
  theme: { text: { base: "#ffffff" } },
  data: {
    session: { get: (id) => ({ id, location: { directory: project(id), workspaceID: "w1" } }) },
    listen: (callback) => { listener = callback; return () => { unsubscribed++ } },
  },
  ui: { slot: (contribution) => {
    assert.equal(contribution.append, "sidebar.content")
    slot = contribution
    return () => { unregistered++ }
  } },
}

assert.equal(plugin.id, "opencode-goal", "native TUI plugin identity must match its established public registration")
const close = await plugin.setup(ctx)
assert.ok(slot)
const rendered = await testRender(
  () => slot.render({ get sessionID() { return selected() } }),
  { width: 60, height: 12 },
)

try {
  await new Promise((r) => setTimeout(r, 120))
  await rendered.renderOnce()
  assert.match(rendered.captureCharFrame(), /OpenCode Goals/)
  assert.match(rendered.captureCharFrame(), /ACTIVE ses_first/)
  select("ses_second")
  await new Promise((r) => setTimeout(r, 120))
  await rendered.renderOnce()
  assert.match(rendered.captureCharFrame(), /ACTIVE ses_second/)
  assert.doesNotMatch(rendered.captureCharFrame(), /ACTIVE ses_first/)
  assert.equal(requests.at(-1).location.directory, project("ses_second"))
  assert.equal(requests.at(-1).location.workspaceID, "w1")

  close()
  close()
  const previous = requests.length
  listener({ details: { type: "server.connected" } })
  await new Promise((r) => setTimeout(r, 135))
  assert.equal(requests.length, previous, "disposed sidebar must not keep polling")
  assert.equal(unregistered, 1, "slot unregisters exactly once")
  assert.equal(unsubscribed, 1, "listener unsubscribes exactly once")
  console.log("Packed Goal strict npm consumer: OpenTUI visible sidebar, session switch and teardown PASS")
} finally {
  close()
  rendered.renderer.destroy()
}
