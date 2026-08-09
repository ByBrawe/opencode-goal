import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { createServer } from "node:http"
import net from "node:net"
import { spawn } from "node:child_process"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const isWindows = process.platform === "win32"
const OBJECTIVE = "prove restart recovery"

function resolveOpenCodeBinary() {
  if (!isWindows) return path.join(repoRoot, "node_modules", ".bin", "opencode")
  const candidates = [
    path.join(repoRoot, "node_modules", "opencode-windows-x64", "bin", "opencode.exe"),
    path.join(repoRoot, "node_modules", "opencode-windows-x64-baseline", "bin", "opencode.exe"),
    path.join(repoRoot, "node_modules", "opencode-windows-arm64", "bin", "opencode.exe"),
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) throw new Error(`OpenCode native Windows binary was not installed. Checked: ${candidates.join(", ")}`)
  return found
}

const opencodeBin = resolveOpenCodeBinary()

function appendLog(current, chunk, limit = 60_000) {
  return (current + String(chunk)).slice(-limit)
}

async function seedConfigDependencies(dir) {
  await mkdir(path.join(dir, "node_modules"), { recursive: true })
  const dependencies = { "@opencode-ai/plugin": "*" }
  await writeFile(path.join(dir, "package.json"), `${JSON.stringify({ private: true, dependencies }, null, 2)}\n`)
  await writeFile(
    path.join(dir, "package-lock.json"),
    `${JSON.stringify({
      name: "opencode-goal-restart-canary-config",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { dependencies } },
    }, null, 2)}\n`,
  )
  await writeFile(path.join(dir, ".gitignore"), "node_modules\npackage.json\npackage-lock.json\nbun.lock\n.gitignore\n")
}

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") return reject(new Error("failed to reserve TCP port"))
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

function spawnOpenCode(args, options = {}) {
  return spawn(opencodeBin, args, { ...options, windowsHide: true })
}

async function stopProcess(child, timeoutMs = 3_000) {
  if (!child || child.exitCode !== null) return
  child.kill()
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve()
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      resolve()
    }, timeoutMs)
    child.once("close", () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function runOpenCode(args, { cwd, env, timeoutMs = 60_000 }) {
  return await new Promise((resolve, reject) => {
    const child = spawnOpenCode(args, { cwd, env })
    let stdout = ""
    let stderr = ""
    let settled = false
    child.stdout?.on("data", (chunk) => { stdout = appendLog(stdout, chunk) })
    child.stderr?.on("data", (chunk) => { stderr = appendLog(stderr, chunk) })
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }
    const timer = setTimeout(() => {
      void stopProcess(child)
      finish(reject, new Error(`OpenCode command timed out: ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, timeoutMs)
    child.once("error", (error) => finish(reject, error))
    child.once("close", (code) => {
      if (code !== 0) {
        finish(reject, new Error(`OpenCode command exited ${code}: ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
        return
      }
      finish(resolve, { stdout, stderr })
    })
  })
}

async function waitForTcp(port, child, logs, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`OpenCode server exited before ready.\n${logs()}`)
    const connected = await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port })
      socket.once("connect", () => { socket.destroy(); resolve(true) })
      socket.once("error", () => resolve(false))
      socket.setTimeout(500, () => { socket.destroy(); resolve(false) })
    })
    if (connected) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for OpenCode server on ${port}\n${logs()}`)
}

function contentText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((part) => typeof part?.text === "string" ? part.text : typeof part?.content === "string" ? part.content : "").join("\n")
}

function allMessageText(body) {
  return (body.messages ?? []).map((message) => contentText(message?.content)).join("\n")
}

function streamHeaders(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
}

function writeSse(res, value) {
  res.write(`data: ${JSON.stringify(value)}\n\n`)
}

function streamText(res, { id, created, content }) {
  streamHeaders(res)
  writeSse(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model: "canary",
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
  })
  writeSse(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model: "canary",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 32, completion_tokens: 3, total_tokens: 35 },
  })
  res.end("data: [DONE]\n\n")
}

function holdText(res, { id, created, content }, held) {
  held.add(res)
  res.once("close", () => held.delete(res))
  streamHeaders(res)
  writeSse(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model: "canary",
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
  })
}

function startProvider() {
  const stats = {
    chatRequests: 0,
    executorRequests: 0,
    paths: [],
  }
  const held = new Set()

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    stats.paths.push(`${req.method} ${url.pathname}`)
    if (req.method === "GET" && url.pathname.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ object: "list", data: [{ id: "canary", object: "model", owned_by: "canary" }] }))
      return
    }
    if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: `unexpected endpoint: ${req.method} ${url.pathname}` } }))
      return
    }

    let raw = ""
    for await (const chunk of req) raw += String(chunk)
    const body = raw ? JSON.parse(raw) : {}
    stats.chatRequests += 1
    const id = `chatcmpl-restart-${stats.chatRequests}`
    const created = Math.floor(Date.now() / 1000)
    const executorRequest = allMessageText(body).includes(OBJECTIVE)

    if (!executorRequest) {
      streamText(res, { id, created, content: "CANARY_OK" })
      return
    }

    stats.executorRequests += 1
    if (stats.executorRequests === 1) {
      streamText(res, { id, created, content: "FIRST_TURN_DONE" })
      return
    }
    if (stats.executorRequests === 2) {
      holdText(res, { id, created, content: "PRE_CRASH_HOLD" }, held)
      return
    }
    if (stats.executorRequests === 3) {
      holdText(res, { id, created, content: "RECOVERY_HOLD" }, held)
      return
    }

    streamText(res, { id, created, content: "UNEXPECTED_DUPLICATE_RECOVERY" })
  })

  return {
    stats,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", resolve)
      })
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("failed to start deterministic restart provider")
      return address.port
    },
    async close() {
      for (const response of held) response.destroy()
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

async function goalFile(workspace) {
  const dir = path.join(workspace, ".opencode", "goals")
  try {
    const files = (await readdir(dir)).filter((name) => name.endsWith(".json"))
    if (!files.length) return null
    assert.equal(files.length, 1, `expected one goal state shard, found ${files.length}`)
    return path.join(dir, files[0])
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}

async function readGoal(workspace) {
  const file = await goalFile(workspace)
  return file ? JSON.parse(await readFile(file, "utf8")) : null
}

async function waitFor(predicate, description, diagnostics, timeoutMs = 35_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for ${description}\n${diagnostics()}`)
}

function startOpenCodeServer({ workspace, env }) {
  return reservePort().then((port) => {
    const child = spawnOpenCode(["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: workspace, env })
    const state = { log: "" }
    child.stdout?.on("data", (chunk) => { state.log = appendLog(state.log, chunk) })
    child.stderr?.on("data", (chunk) => { state.log = appendLog(state.log, chunk) })
    return { child, port, state }
  })
}

function makeApi(baseURL, workspace, diagnostics) {
  const directoryQuery = `directory=${encodeURIComponent(workspace)}`
  return async (pathname, init = {}) => {
    const separator = pathname.includes("?") ? "&" : "?"
    const scoped = `${pathname}${separator}${directoryQuery}`
    const response = await fetch(`${baseURL}${scoped}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
      signal: init.signal ?? AbortSignal.timeout(20_000),
    }).catch((error) => {
      throw new Error(`OpenCode API ${init.method ?? "GET"} ${scoped} failed: ${String(error)}\n${diagnostics()}`)
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}\n${diagnostics()}`)
    if (!text) return null
    try { return JSON.parse(text) } catch { return text }
  }
}

async function main() {
  const provider = startProvider()
  const providerPort = await provider.listen()
  const workspace = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-restart-canary-"))
  const home = path.join(workspace, ".home")
  const projectConfig = path.join(workspace, ".opencode")
  const globalConfig = path.join(home, ".config", "opencode")
  const pluginDir = path.join(projectConfig, "plugins")
  let firstServer = null
  let secondServer = null
  let firstGoal = null
  let recoveredGoal = null
  let sessionID = ""

  try {
    await mkdir(pluginDir, { recursive: true })
    await seedConfigDependencies(projectConfig)
    await seedConfigDependencies(globalConfig)
    const pluginEntry = pathToFileURL(path.join(repoRoot, "dist", "index.js")).href
    await writeFile(path.join(pluginDir, "opencode-goal.js"), `export { default as OpenCodeGoalPlugin } from ${JSON.stringify(pluginEntry)}\n`)
    await writeFile(path.join(workspace, "README.md"), "# Restart canary\n")
    await writeFile(path.join(workspace, "opencode.json"), `${JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: "canary/canary",
      small_model: "canary/canary",
      provider: {
        canary: {
          npm: "@ai-sdk/openai-compatible",
          name: "Deterministic Restart Canary",
          options: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "canary-key" },
          models: { canary: { name: "Deterministic Restart Canary", limit: { context: 100000, output: 4096 } } },
        },
      },
    }, null, 2)}\n`)

    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local", "share"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
      CI: "true",
    }
    // Intentionally do not set OPENCODE_DB=:memory:. The same isolated HOME and
    // XDG data directory are reused by both processes so OpenCode's real SQLite
    // session store must survive the process boundary.

    const prewarm = await runOpenCode(["debug", "config"], { cwd: workspace, env, timeoutMs: 60_000 })
    assert.match(prewarm.stdout, /\{[\s\S]*\}/, `OpenCode config prewarm returned no JSON\n${prewarm.stdout}\n${prewarm.stderr}`)

    firstServer = await startOpenCodeServer({ workspace, env })
    const firstDiagnostics = () => `provider=${JSON.stringify(provider.stats)}\nstate=${JSON.stringify(firstGoal, null, 2)}\nserver1 log:\n${firstServer?.state.log ?? ""}`
    await waitForTcp(firstServer.port, firstServer.child, () => firstServer.state.log)
    const firstApi = makeApi(`http://127.0.0.1:${firstServer.port}`, workspace, firstDiagnostics)
    await firstApi("/session", { method: "GET", signal: AbortSignal.timeout(45_000) })

    const createdPayload = await firstApi("/session", {
      method: "POST",
      body: JSON.stringify({ title: "opencode-goal restart canary" }),
    })
    const session = createdPayload?.data ?? createdPayload
    sessionID = String(session?.id ?? "")
    assert.ok(sessionID, `OpenCode did not create a session: ${JSON.stringify(createdPayload)}`)

    const commandController = new AbortController()
    const command = firstApi(`/session/${encodeURIComponent(sessionID)}/command`, {
      method: "POST",
      body: JSON.stringify({ agent: "build", model: "canary/canary", command: "goal", arguments: `${OBJECTIVE} --max-turns 8` }),
      signal: commandController.signal,
    }).catch(() => null)

    await waitFor(
      async () => {
        firstGoal = await readGoal(workspace)
        return provider.stats.executorRequests >= 2 && firstGoal?.sessionID === sessionID && firstGoal?.status === "active"
      },
      "initial turn followed by one in-flight continuation before restart",
      firstDiagnostics,
      45_000,
    )

    const goalID = firstGoal.id
    const revision = firstGoal.revision
    const objective = firstGoal.objective
    const stalledBeforeRestart = firstGoal.stalledTurns
    assert.equal(provider.stats.executorRequests, 2, "the pre-restart phase must have exactly one continuation in flight")
    assert.equal(objective, OBJECTIVE)

    await stopProcess(firstServer.child)
    commandController.abort()
    await command
    firstServer = null

    secondServer = await startOpenCodeServer({ workspace, env })
    const secondDiagnostics = () => `provider=${JSON.stringify(provider.stats)}\npreRestart=${JSON.stringify(firstGoal, null, 2)}\nrecovered=${JSON.stringify(recoveredGoal, null, 2)}\nserver2 log:\n${secondServer?.state.log ?? ""}`
    await waitForTcp(secondServer.port, secondServer.child, () => secondServer.state.log)
    const secondApi = makeApi(`http://127.0.0.1:${secondServer.port}`, workspace, secondDiagnostics)

    const sessionsPayload = await secondApi("/session", { method: "GET", signal: AbortSignal.timeout(45_000) })
    const sessions = sessionsPayload?.data ?? sessionsPayload
    assert.ok(Array.isArray(sessions), `restarted OpenCode did not return sessions: ${JSON.stringify(sessionsPayload)}`)
    assert.ok(sessions.some((item) => String(item?.id ?? "") === sessionID), `persistent SQLite did not recover session ${sessionID}`)

    await waitFor(
      async () => {
        recoveredGoal = await readGoal(workspace)
        return provider.stats.executorRequests >= 3
      },
      "one automatic recovery continuation after process restart",
      secondDiagnostics,
      45_000,
    )

    assert.equal(provider.stats.executorRequests, 3, "restart must create exactly one recovery continuation")
    await new Promise((resolve) => setTimeout(resolve, 750))
    assert.equal(provider.stats.executorRequests, 3, "restart recovery must not dispatch concurrent duplicate continuations")

    recoveredGoal = await readGoal(workspace)
    assert.ok(recoveredGoal, "goal shard disappeared across restart")
    assert.equal(recoveredGoal.id, goalID)
    assert.equal(recoveredGoal.sessionID, sessionID)
    assert.equal(recoveredGoal.revision, revision)
    assert.equal(recoveredGoal.objective, objective)
    assert.equal(recoveredGoal.status, "active")
    assert.ok(recoveredGoal.stalledTurns >= stalledBeforeRestart, "restart must not rewind no-progress accounting")
    assert.equal(secondServer.child.exitCode, null, `restarted OpenCode server exited unexpectedly: ${secondDiagnostics()}`)

    console.log(JSON.stringify({
      ok: true,
      platform: process.platform,
      sessionID,
      goalID,
      revision,
      executorRequests: provider.stats.executorRequests,
      stalledBeforeRestart,
      stalledAfterRestart: recoveredGoal.stalledTurns,
      providerPaths: [...new Set(provider.stats.paths)],
    }, null, 2))
  } finally {
    if (firstServer) await stopProcess(firstServer.child).catch(() => undefined)
    if (secondServer) await stopProcess(secondServer.child).catch(() => undefined)
    await provider.close().catch(() => undefined)
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined)
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
