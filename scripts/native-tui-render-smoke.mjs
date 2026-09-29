import assert from 'node:assert/strict'
import { testRender } from '@opentui/solid'
import { createSignal } from 'solid-js'
import plugin from '../dist/tui/index.js'

let contribution, listener, requests = [], unregisters = 0, unsubscribes = 0
const [sessionID, selectSession] = createSignal('ses_one')
const context = {
  client: { rpc: () => ({ read: async (input, options) => {
    requests.push({ input, options })
    return { schemaVersion: 1, sessionID: input.sessionID, directory: options.location.directory, text: `OpenCode Goals\nACTIVE ${input.sessionID}` }
  } }) },
  theme: { text: { base: '#ffffff' } },
  data: {
    session: { get: (id) => ({ id, location: { directory: `/remote/${id}`, workspaceID: id } }) },
    listen: (callback) => { listener = callback; return () => { unsubscribes++ } },
  },
  ui: { slot(definition) { assert.equal(definition.append, 'sidebar.content'); contribution = definition; return () => { unregisters++ } } },
}
const close = await plugin.setup(context)
const view = await testRender(() => contribution.render({ get sessionID() { return sessionID() } }), { width: 60, height: 12 })
try {
  await new Promise((resolve) => setTimeout(resolve, 100))
  await view.renderOnce()
  assert.match(view.captureCharFrame(), /ACTIVE ses_one/)
  selectSession('ses_two')
  await new Promise((resolve) => setTimeout(resolve, 100))
  await view.renderOnce()
  assert.match(view.captureCharFrame(), /ACTIVE ses_two/)
  assert.doesNotMatch(view.captureCharFrame(), /ACTIVE ses_one/)
  assert.equal(requests.at(-1).options.location.directory, '/remote/ses_two')
  close(); close()
  const count = requests.length
  listener({ details: { type: 'server.connected' } })
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(requests.length, count)
  assert.equal(unregisters, 1)
  assert.equal(unsubscribes, 1)
  console.log('Native V2 slot renders and switches remote sessions; cleanup is idempotent: PASS')
} finally { close(); view.renderer.destroy() }
