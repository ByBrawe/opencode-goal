import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, readdir, mkdir, symlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import { registerGoalStatusRpc } from '../dist/opencode2/status-rpc.js'
import { createGoalStatusController } from '../dist/tui/status-controller.js'
import tui from '../dist/tui/index.js'

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const response = (sessionID, directory, text) => ({ schemaVersion: 1, sessionID, directory, text })
test('published Goal TUI exposes native setup while retaining lazy V1 compatibility', () => {
  assert.equal(typeof tui.setup, 'function')
  assert.equal(typeof tui.tui, 'function')
})
test('server status is session-location bound, read-only, and revoked at cleanup', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'goal-rpc-'))
  let implementation, releases = 0
  let session = { id: 'ses_status', location: { directory: root } }
  const close = await registerGoalStatusRpc({
    location: { directory: root }, session: { get: async () => session },
    rpc: { register: async (definition, handlers) => { assert.equal(definition.id, 'opencode-goal-status'); implementation = handlers; return { dispose() { releases++ } } } },
  })
  try {
    const before = await readdir(root)
    assert.match((await implementation.read({ sessionID: 'ses_status' }, {})).text, /No live Goal/)
    assert.deepEqual(await readdir(root), before, 'status must not create control-plane files')
    for (const changed of [null, { id: 'wrong', location: { directory: root } }, { id: 'ses_status' }, { id: 'ses_status', location: { directory: path.dirname(root) } }, { id: 'ses_status', location: { directory: root, workspaceID: 'foreign' } }]) {
      session = changed
      await assert.rejects(implementation.read({ sessionID: 'ses_status' }, {}), /unavailable/)
    }
    session = { id: 'ses_status', location: { directory: root } }
    await assert.rejects(implementation.read({ sessionID: 'ses_status', directory: '/injected' }, {}), /unavailable/)
    const first = close()
    assert.strictEqual(close(), first)
    await first
    await assert.rejects(implementation.read({ sessionID: 'ses_status' }, {}), /unavailable/)
    assert.equal(releases, 1)
  } finally { await close(); await rm(root, { recursive: true, force: true }) }
})
test('corrupt Goal storage is visible and never repaired by status RPC', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'goal-rpc-corrupt-'))
  const sessionID = 'ses_corrupt'
  const filename = path.join(root, '.opencode', 'goals', createHash('sha256').update(sessionID).digest('hex').slice(0, 32) + '.json')
  await mkdir(path.dirname(filename), { recursive: true })
  await writeFile(filename, '{broken')
  let read
  const close = await registerGoalStatusRpc({ location: { directory: root }, session: { get: async () => ({ id: sessionID, location: { directory: root } }) }, rpc: { register: async (_definition, implementation) => { read = implementation.read; return { dispose() {} } } } })
  try {
    assert.match((await read({ sessionID }, {})).text, /storage unavailable/)
    assert.equal(await readFile(filename, 'utf8'), '{broken')
  } finally { await close(); await rm(root, { recursive: true, force: true }) }
})
test('unload during native session lookup rejects the stale RPC result', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'goal-rpc-unload-'))
  const lookup = deferred()
  let read
  const close = await registerGoalStatusRpc({ location: { directory: root }, session: { get: () => lookup.promise }, rpc: { register: async (_definition, implementation) => { read = implementation.read; return { dispose() {} } } } })
  try {
    const pending = read({ sessionID: 'ses_late' }, {})
    const rejected = assert.rejects(pending, /unavailable/)
    await close()
    lookup.resolve({ id: 'ses_late', location: { directory: root } })
    await rejected
  } finally { await close(); await rm(root, { recursive: true, force: true }) }
})
test('remote UI sends actual session location and rejects out-of-order responses', async () => {
  const calls = [], shown = []
  const controller = createGoalStatusController({ pollMs: 60000, read(input, options) { const pending = deferred(); calls.push({ input, options, pending }); return pending.promise }, publish: (text) => shown.push(text) })
  try {
    const old = controller.select('ses_old', { directory: 'C:\\remote\\old', workspaceID: 'one' })
    await Promise.resolve(); await Promise.resolve()
    const next = controller.select('ses_new', { directory: '/remote/new', workspaceID: 'two' })
    await Promise.resolve(); await Promise.resolve()
    assert.deepEqual(calls[1].options.location, { directory: '/remote/new', workspaceID: 'two' })
    assert.equal(calls[0].options.signal.aborted, true)
    calls[1].pending.resolve(response('ses_new', '/remote/new', 'NEW'))
    await next
    calls[0].pending.resolve(response('ses_old', 'C:\\remote\\old', 'OLD'))
    await old
    assert.equal(shown.at(-1), 'NEW')
    assert.ok(!shown.includes('OLD'))
  } finally { controller.dispose() }
})
test('missing remote location never falls back to local disk or calls RPC', async () => {
  let calls = 0, text
  const controller = createGoalStatusController({ read: async () => { calls++; throw new Error('unexpected') }, publish: (value) => { text = value } })
  try { await controller.select('ses_missing', undefined); assert.equal(calls, 0); assert.match(text, /location unavailable/) }
  finally { controller.dispose() }
})
test('busy events coalesce while a status request is pending', async () => {
  const pending = deferred(); let calls = 0
  const controller = createGoalStatusController({ pollMs: 60000, read: () => { calls++; return pending.promise }, publish() {} })
  try {
    const task = controller.select('ses_busy', { directory: '/remote' })
    await Promise.resolve(); await Promise.resolve()
    for (let i = 0; i < 100; i++) controller.invalidate('ses_busy')
    assert.equal(calls, 1)
    pending.resolve(response('ses_busy', '/remote', 'OK'))
    await task
  } finally { controller.dispose() }
})
test('timeout and mismatched status are visibly unavailable, never no-live-Goal', async () => {
  let text
  const controller = createGoalStatusController({ timeoutMs: 20, pollMs: 60000, read: () => new Promise(() => {}), publish: (value) => { text = value } })
  const keepAlive = setTimeout(() => {}, 200)
  try { await controller.select('ses_timeout', { directory: '/remote' }); assert.match(text, /Server Goal status unavailable/); assert.doesNotMatch(text, /No live Goal/) }
  finally { clearTimeout(keepAlive); controller.dispose() }
  const mismatch = createGoalStatusController({ read: async () => response('wrong', '/remote', 'DO NOT SHOW'), publish: (value) => { text = value } })
  try { await mismatch.select('ses_right', { directory: '/remote' }); assert.match(text, /unavailable/); assert.doesNotMatch(text, /DO NOT SHOW/) }
  finally { mismatch.dispose() }
})
test('disposed sidebar cannot issue a late request or publish a late result', async () => {
  let calls = 0; const shown = []
  const controller = createGoalStatusController({ read: async () => { calls++; return response('ses_late', '/remote', 'LATE') }, publish: (text) => shown.push(text) })
  const pending = controller.select('ses_late', { directory: '/remote' })
  controller.dispose()
  await pending
  assert.equal(calls, 0)
  assert.ok(!shown.includes('LATE'))
})
