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
const OBJECTIVE = "real host progress canary"
const TARGET_NAME = "goal-progress-canary.txt"
const TARGET_CONTENT = "REAL_PATCH_PROGRESS\n"

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
      name: "opencode-goal-progress-canary-config",
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

async function stopProcess(child, timeoutMs = 2_000) {
  if (!child || child.exitCode !== null) return
  child.kill()
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve()
    const timer = setTimeout(resolve, timeoutMs)
    child.once("close", () => { clearTimeout(timer); resolve() })
  })
}

function spawnOpenCode(args, options = {}) {
  return spawn(opencodeBin, args, { ...options, windowsHide: true })
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

function contentText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((part) => typeof part?.text === "string" ? part.text : typeof part?.content === "string" ? part.content : "").join("\n")
}

function allMessageText(body) {
  return (body.messages ?? []).map((message) => contentText(message?.content)).join("\n")
}

function toolDefinition(body, name) {
  return (body.tools ?? []).find((item) => item?.function?.name === name)
}

function writeArgs(body, absolutePath) {
  const definition = toolDefinition(body, "write")
  if (!definition) throw new Error("real OpenCode request did not expose the write tool")
  const properties = definition.function?.parameters?.properties ?? {}
  if (Object.prototype.hasOwnProperty.call(properties, "path")) return { path: absolutePath, content: TARGET_CONTENT }
  if (Object.prototype.hasOwnProperty.call(properties, "filePath")) return { filePath: absolutePath, content: TARGET_CONTENT }
  if (Object.prototype.hasOwnProperty.call(properties, "file_path")) return { file_path: absolutePath, content: TARGET_CONTENT }
  throw new Error(`unsupported OpenCode write schema: ${JSON.stringify(definition.function?.parameters ?? null)}`)
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

function streamToolCall(res, { id, created, callID, name, args }) {
  streamHeaders(res)
  writeSse(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model: "canary",
    choices: [{
      index: 0,
      delta: {
        role: "assistant",
        content: null,
        tool_calls: [{ index: 0, id: callID, type: "function", function: { name, arguments: "" } }],
      },
      finish_reason: null,
    }],
  })
  writeSse(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model: "canary",
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }, finish_reason: null }],
  })
  writeSse(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model: "canary",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
  })
  res.end("data: [DONE]\n\n")
}

function startProvider(targetPath) {
  const stats = {
    chatRequests: 0,
    phase: "mutate",
    mutationWriteCalls: 0,
    noopWriteCalls: 0,
    holdStarted: 0,
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
    const id = `chatcmpl-progress-${stats.chatRequests}`
    const created = Math.floor(Date.now() / 1000)
    const text = allMessageText(body)
    const executorRequest = text.includes(OBJECTIVE) && Boolean(toolDefinition(body, "write"))

    if (!executorRequest) {
      streamText(res, { id, created, content: "CANARY_OK" })
      return
    }

    if (stats.phase === "mutate") {
      stats.phase = "mutate-result"
      stats.mutationWriteCalls += 1
      streamToolCall(res, { id, created, callID: "call-real-mutation", name: "write", args: writeArgs(body, targetPath) })
      return
    }
    if (stats.phase === "mutate-result") {
      stats.phase = "noop"
      streamText(res, { id, created, content: "REAL_MUTATION_DONE" })
      return
    }
    if (stats.phase === "noop") {
      stats.phase = "noop-result"
      stats.noopWriteCalls += 1
      streamToolCall(res, { id, created, callID: "call-noop-mutation", name: "write", args: writeArgs(body, targetPath) })
      return
    }
    if (stats.phase === "noop-result") {
      stats.phase = "hold"
      streamText(res, { id, created, content: "NOOP_MUTATION_DONE" })
      return
    }
    if (stats.phase === "hold") {
      stats.phase = "holding"
      stats.holdStarted += 1
      held.add(res)
      res.once("close", () => held.delete(res))
      streamHeaders(res)
      writeSse(res, {
        id,
        object: "chat.completion.chunk",
        created,
        model: "canary",
        choices: [{ index: 0, delta: { role: "assistant", content: "HOLD_AFTER_NOOP" }, finish_reason: null }],
      })
      return
    }

    streamText(res, { id, created, content: "UNEXPECTED_EXTRA_TURN" })
  })

  return {
    stats,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", resolve)
      })
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("failed to start deterministic progress provider")
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
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`timed out waiting for ${description}\n${diagnostics()}`)
}

async function main() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-progress-canary-"))
  const home = path.join(workspace, ".home")
  const projectConfig = path.join(workspace, ".opencode")
  const globalConfig = path.join(home, ".config", "opencode")
  const pluginDir = path.join(projectConfig, "plugins")
  const targetPath = path.join(workspace, TARGET_NAME)
  const provider = startProvider(targetPath)
  const providerPort = await provider.listen()
  let lastState = null

  await mkdir(pluginDir, { recursive: true })
  await seedConfigDependencies(projectConfig)
  await seedConfigDependencies(globalConfig)
  const pluginEntry = pathToFileURL(path.join(repoRoot, "dist", "index.js")).href
  await writeFile(path.join(pluginDir, "opencode-goal.js"), `export { default as OpenCodeGoalPlugin } from ${JSON.stringify(pluginEntry)}\n`)
  await writeFile(path.join(workspace, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "canary/canary",
    small_model: "canary/canary",
    permission: { edit: "allow" },
    provider: {
      canary: {
        npm: "@ai-sdk/openai-compatible",
        name: "Deterministic Host Progress Canary",
        options: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "canary-key" },
        models: { canary: { name: "Deterministic Host Progress Canary", limit: { context: 100000, output: 4096 } } },
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
    OPENCODE_DB: ":memory:",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    CI: "true",
  }

  const prewarm = await runOpenCode(["debug", "config"], { cwd: workspace, env, timeoutMs: 60_000 })
  assert.match(prewarm.stdout, /\{[\s\S]*\}/, `OpenCode config prewarm returned no JSON\n${prewarm.stdout}\n${prewarm.stderr}`)

  const port = await reservePort()
  const server = spawnOpenCode(["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: workspace, env })
  let serverLog = ""
  server.stdout?.on("data", (chunk) => { serverLog = appendLog(serverLog, chunk) })
  server.stderr?.on("data", (chunk) => { serverLog = appendLog(serverLog, chunk) })
  const baseURL = `http://127.0.0.1:${port}`
  const directoryQuery = `directory=${encodeURIComponent(workspace)}`
  const diagnostics = () => `provider=${JSON.stringify(provider.stats)}\nstate=${JSON.stringify(lastState, null, 2)}\nserver log:\n${serverLog}`

  const api = async (pathname, init = {}) => {
    const separator = pathname.includes("?") ? "&" : "?"
    const scoped = `${pathname}${separator}${directoryQuery}`
    const response = await fetch(`${baseURL}${scoped}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
      signal: init.signal ?? AbortSignal.timeout(20_000),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`)
    if (!text) return null
    try { return JSON.parse(text) } catch { return text }
  }

  try {
    await waitForTcp(port, server, () => serverLog)
    const sessionsBefore = await api("/session", { method: "GET", signal: AbortSignal.timeout(45_000) })
    assert.ok(Array.isArray(sessionsBefore?.data ?? sessionsBefore), "GET /session bootstrap probe did not return a session array")

    const createdPayload = await api("/session", { method: "POST", body: JSON.stringify({ title: "opencode-goal progress canary" }) })
    const session = createdPayload?.data ?? createdPayload
    const sessionID = String(session?.id ?? "")
    assert.ok(sessionID, `OpenCode did not create a session: ${JSON.stringify(createdPayload)}`)

    const command = api(`/session/${encodeURIComponent(sessionID)}/command`, {
      method: "POST",
      body: JSON.stringify({ agent: "build", model: "canary/canary", command: "goal", arguments: `${OBJECTIVE} --max-turns 8` }),
      signal: AbortSignal.timeout(60_000),
    })

    await waitFor(
      async () => {
        lastState = await readGoal(workspace)
        return provider.stats.mutationWriteCalls === 1 && (lastState?.progressFingerprints?.length ?? 0) === 1
      },
      "real file mutation to produce one revision-owned host fingerprint",
      diagnostics,
    )
    const afterMutation = await readGoal(workspace)
    assert.equal(await readFile(targetPath, "utf8"), TARGET_CONTENT)
    assert.equal(afterMutation.progressRevision, 1, `real mutation should increment progress once: ${JSON.stringify(afterMutation.progressFingerprints)}`)
    assert.equal(afterMutation.progressFingerprints.length, 1)
    const firstFingerprint = afterMutation.progressFingerprints[0]
    assert.match(firstFingerprint, /^file:goal-progress-canary\.txt:[a-f0-9]{64}$/)

    await waitFor(
      async () => {
        lastState = await readGoal(workspace)
        return provider.stats.noopWriteCalls === 1 && provider.stats.holdStarted === 1
      },
      "no-op write turn to finish and next continuation to begin",
      diagnostics,
    )
    await new Promise((resolve) => setTimeout(resolve, 250))
    lastState = await readGoal(workspace)

    assert.equal(await readFile(targetPath, "utf8"), TARGET_CONTENT)
    assert.equal(lastState.progressRevision, 1, "writing identical content must not count as new progress")
    assert.deepEqual(lastState.progressFingerprints, [firstFingerprint], "no-op write must not create a new host-progress fingerprint")
    assert.equal(lastState.stalledTurns, 1, "the no-op turn should count as one stalled continuation")
    assert.equal(provider.stats.mutationWriteCalls, 1)
    assert.equal(provider.stats.noopWriteCalls, 1)

    console.log(JSON.stringify({
      ok: true,
      platform: process.platform,
      sessionID,
      mutationWriteCalls: provider.stats.mutationWriteCalls,
      noopWriteCalls: provider.stats.noopWriteCalls,
      holdStarted: provider.stats.holdStarted,
      progressRevision: lastState.progressRevision,
      progressFingerprints: lastState.progressFingerprints,
      stalledTurns: lastState.stalledTurns,
    }, null, 2))

    void command.catch(() => undefined)
  } finally {
    await stopProcess(server)
    await provider.close().catch(() => undefined)
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined)
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
