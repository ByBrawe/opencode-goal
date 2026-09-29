import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createGoal, pauseGoal } from '../dist/domain/goal.js'
import { GoalStore } from '../dist/persistence/store.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const binary = process.env.OPENCODE2_BINARY || 'opencode2'
const expectedVersion = process.env.OPENCODE2_EXPECTED_VERSION || '2.0.18'
const temp = await mkdtemp(path.join(os.tmpdir(), 'goal-native-rpc-host-'))
const home = path.join(temp, 'home'), a = path.join(temp, 'project-a'), b = path.join(temp, 'project-b')
const password = 'isolated-goal-rpc-canary'
const env = { ...process.env, HOME: home, USERPROFILE: home,
  XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
  XDG_STATE_HOME: path.join(home, '.local/state'), XDG_CACHE_HOME: path.join(home, '.cache'),
  OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_SERVER_PASSWORD: password,
  OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_LSP_DOWNLOAD: 'true', CI: 'true',
}
let child, log = ''
try {
  for (const dir of [home, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_STATE_HOME, env.XDG_CACHE_HOME, a, b]) await mkdir(dir, { recursive: true })
  for (const dir of [a, b]) {
    const plugins = path.join(dir, '.opencode/plugins')
    await mkdir(plugins, { recursive: true })
    await writeFile(path.join(plugins, 'goal.js'), `export { default } from ${JSON.stringify(pathToFileURL(path.join(root, 'dist/server.js')).href)}\n`)
    await writeFile(path.join(dir, 'README.md'), '# Native status RPC fixture\n')
    execFileSync('git', ['init', '--quiet', dir], { stdio: 'ignore' })
  }
  const version = execFileSync(binary, ['--version'], { cwd: a, env, encoding: 'utf8', timeout: 10000 }).trim()
  assert.match(version, new RegExp(`(?:^|v)${expectedVersion.replaceAll('.', '\\.')}\\s*$`), `Unexpected host: ${version}`)
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(error => error ? reject(error) : resolve(value)) })
  })
  child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: a, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', chunk => { log = (log + chunk).slice(-40000) })
  child.stderr.on('data', chunk => { log = (log + chunk).slice(-40000) })
  const request = async (directory, endpoint, data) => {
    const reply = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-opencode-directory': directory, authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(10000),
    })
    const text = await reply.text()
    let body
    try { body = JSON.parse(text) } catch { body = text }
    return { ok: reply.ok, status: reply.status, body }
  }
  for (const directory of [a, b]) {
    let active = false
    const deadline = Date.now() + 45000
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Host exited ${child.exitCode}: ${log}`)
      const reply = await request(directory, '/api/plugin').catch(() => null)
      const values = reply?.body?.data ?? reply?.body
      active = Array.isArray(values) && values.some(value => value.id === '@bybrawe/opencode-goal' && value.state?.status === 'active')
      if (active) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(active, `Goal failed activation in ${directory}: ${log}`)
  }
  const ids = []
  for (const [directory, objective] of [[a, 'LOCAL STATUS A'], [b, 'REMOTE STATUS B']]) {
    const created = await request(directory, '/api/session', { title: objective, location: { directory } })
    assert.equal(created.ok, true, JSON.stringify(created))
    const sessionID = (created.body?.data ?? created.body)?.id
    assert.equal(typeof sessionID, 'string')
    ids.push(sessionID)
    const store = new GoalStore(directory)
    await store.save(pauseGoal(createGoal({ sessionID, objective, acceptance: ['status is read only'] }), 'read-only RPC fixture'))
    const file = path.join(directory, '.opencode/goals', createHash('sha256').update(sessionID).digest('hex').slice(0, 32) + '.json')
    const before = await readFile(file, 'utf8')
    const status = await request(directory, '/api/rpc/opencode-goal-status/read', { input: { sessionID } })
    assert.equal(status.ok, true, `RPC failed: ${JSON.stringify(status)}\n${log}`)
    assert.equal(status.body.output.schemaVersion, 1)
    assert.equal(status.body.output.sessionID, sessionID)
    assert.equal(status.body.output.directory, directory)
    assert.ok(status.body.output.text.includes(objective))
    assert.equal(await readFile(file, 'utf8'), before, 'read-only status changed Goal storage')
  }
  const wrong = await request(a, '/api/rpc/opencode-goal-status/read', { input: { sessionID: ids[1] } })
  assert.equal(wrong.ok, false, 'location A must not disclose or adopt the Goal from B')
  const injected = await request(a, '/api/rpc/opencode-goal-status/read', { input: { sessionID: ids[0], directory: b } })
// The native JSON-schema boundary may strip extra input fields.
// Whether rejected or sanitized, they must never redirect a read.
if (injected.ok) {
  assert.equal(injected.body.output.sessionID, ids[0])
  assert.equal(injected.body.output.directory, a)
  assert.ok(injected.body.output.text.includes('LOCAL STATUS A'))
  assert.ok(!injected.body.output.text.includes('REMOTE STATUS B'))
}
  console.log(JSON.stringify({ ok: true, version, sessions: ids.length, nativeRPC: true, readOnly: true, foreignLocationRejected: true, injectedPathCannotRedirect: true }, null, 2))
} finally {
  if (child && child.exitCode === null) {
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 5000)
      child.once('close', () => { clearTimeout(timer); resolve() })
      child.kill('SIGTERM')
    })
  }
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
