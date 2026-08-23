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
const OLD_OBJECTIVE = "finish the original host revision canary project"
const USER_EXTENSION = [
  "şimdi bunları da yap:",
  "1. ödeme API akışını ekle",
  "2. hata durumlarını test et",
  "3. yayın doğrulamasını bitir",
].join("\n")
const OLD_TODOS = [
  { content: "Old plan item", status: "in_progress", priority: "high" },
  { content: "Old verification", status: "pending", priority: "medium" },
]
const NEW_TODOS = [
  { content: "Re-plan the revised Goal from the exact user extension", status: "in_progress", priority: "high" },
  { content: "Implement the newly required work", status: "pending", priority: "high" },
  { content: "Verify the revised Goal end-to-end", status: "pending", priority: "medium" },
]

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
      name: "opencode-goal-user-revision-canary-config",
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

function lastUserText(body) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return contentText(messages[index]?.content)
  }
  return ""
}

function messageText(body) {
  return (body.messages ?? []).map((message) => contentText(message?.content)).join("\n")
}

function toolNames(body) {
  return new Set((body.tools ?? []).map((item) => String(item?.function?.name ?? "")).filter(Boolean))
}

function priorToolCallNames(body) {
  const names = []
  for (const message of body.messages ?? []) {
    for (const call of message?.tool_calls ?? []) {
      const name = String(call?.function?.name ?? "")
      if (name) names.push(name)
    }
  }
  return names
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
    usage: { prompt_tokens: 48, completion_tokens: 6, total_tokens: 54 },
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
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] },
      finish_reason: null,
    }],
  })
  writeSse(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model: "canary",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 64, completion_tokens: 16, total_tokens: 80 },
  })
  res.end("data: [DONE]\n\n")
}

function startHeldStream(res, { id, created }, stats) {
  streamHeaders(res)
  writeSse(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model: "canary",
    choices: [{ index: 0, delta: { role: "assistant", content: "OLD_PLAN_READY" }, finish_reason: null }],
  })
  stats.heldResponses.add(res)
  res.once("close", () => {
    if (stats.heldResponses.delete(res)) stats.oldHeldClosed += 1
  })
}

function startProvider() {
  const stats = {
    chatRequests: 0,
    paths: [],
    oldTodoCalls: 0,
    oldHeldClosed: 0,
    revisionCalls: 0,
    revisedTodoCalls: 0,
    sawRevisionTool: false,
    sawRevisionGuidance: false,
    sawExactUserExtension: false,
    sawRevisionToolResult: false,
    sawRevisedGoalPrompt: false,
    heldResponses: new Set(),
  }

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
    const id = `chatcmpl-user-revision-${stats.chatRequests}`
    const created = Math.floor(Date.now() / 1000)
    const lastUser = lastUserText(body)
    const allText = messageText(body)
    const tools = toolNames(body)
    const priorTools = priorToolCallNames(body)

    stats.sawRevisionTool ||= tools.has("opencode_goal_revise_from_user")

    if (lastUser.includes(USER_EXTENSION)) {
      stats.sawExactUserExtension ||= USER_EXTENSION.split("\n").every((line) => lastUser.includes(line))
      stats.sawRevisionGuidance ||= lastUser.includes("<opencode_goal_user_revision>")
        && lastUser.includes("mode=extend")
        && lastUser.includes("mode=replace")

      if (!priorTools.includes("opencode_goal_revise_from_user")) {
        assert.ok(tools.has("opencode_goal_revise_from_user"), `revision tool missing from real OpenCode request; tools=${[...tools].join(",")}`)
        stats.revisionCalls += 1
        streamToolCall(res, {
          id,
          created,
          callID: `call-user-revision-${stats.chatRequests}`,
          name: "opencode_goal_revise_from_user",
          args: { mode: "extend" },
        })
        return
      }

      stats.sawRevisionToolResult ||= allText.includes("Goal revised from the exact foreground user instruction")
      streamText(res, { id, created, content: "REVISION_BOUNDARY_ACK" })
      return
    }

    const revisedPrompt = lastUser.includes(OLD_OBJECTIVE)
      && lastUser.includes("Additional user instruction:")
      && USER_EXTENSION.split("\n").every((line) => lastUser.includes(line))
    if (revisedPrompt) {
      stats.sawRevisedGoalPrompt = true
      assert.ok(tools.has("todowrite"), `revised Goal continuation did not expose native todowrite; tools=${[...tools].join(",")}`)
      if (stats.revisedTodoCalls === 0) {
        stats.revisedTodoCalls += 1
        streamToolCall(res, {
          id,
          created,
          callID: `call-revised-todo-${stats.chatRequests}`,
          name: "todowrite",
          args: { todos: NEW_TODOS },
        })
        return
      }
      streamText(res, { id, created, content: "REVISED_PLAN_READY" })
      return
    }

    if (lastUser.includes(OLD_OBJECTIVE)) {
      assert.ok(tools.has("todowrite"), `initial Goal request did not expose native todowrite; tools=${[...tools].join(",")}`)
      if (!priorTools.includes("todowrite")) {
        stats.oldTodoCalls += 1
        streamToolCall(res, {
          id,
          created,
          callID: `call-old-todo-${stats.chatRequests}`,
          name: "todowrite",
          args: { todos: OLD_TODOS },
        })
        return
      }
      startHeldStream(res, { id, created }, stats)
      return
    }

    streamText(res, { id, created, content: "USER_REVISION_CANARY_OK" })
  })

  return {
    stats,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", resolve)
      })
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("failed to start deterministic user-revision provider")
      return address.port
    },
    async close() {
      for (const response of stats.heldResponses) response.destroy()
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

async function waitForGoal(workspace, predicate, description, diagnostics, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await readGoal(workspace)
    if (last && predicate(last)) return last
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for ${description}. Last state: ${JSON.stringify(last, null, 2)}\n${diagnostics()}`)
}

async function waitFor(predicate, description, diagnostics, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`timed out waiting for ${description}\n${diagnostics()}`)
}

async function main() {
  const provider = startProvider()
  const providerPort = await provider.listen()
  const workspace = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-user-revision-canary-"))
  const home = path.join(workspace, ".home")
  const projectConfig = path.join(workspace, ".opencode")
  const globalConfig = path.join(home, ".config", "opencode")
  const pluginDir = path.join(projectConfig, "plugins")

  await mkdir(pluginDir, { recursive: true })
  await seedConfigDependencies(projectConfig)
  await seedConfigDependencies(globalConfig)
  const pluginEntry = pathToFileURL(path.join(repoRoot, "dist", "index.js")).href
  await writeFile(path.join(pluginDir, "opencode-goal.js"), `export { default as OpenCodeGoalPlugin } from ${JSON.stringify(pluginEntry)}\n`)
  await writeFile(path.join(workspace, "README.md"), "# User revision host canary\n")
  await writeFile(path.join(workspace, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "canary/canary",
    small_model: "canary/canary",
    provider: {
      canary: {
        npm: "@ai-sdk/openai-compatible",
        name: "Deterministic User Revision Canary",
        options: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "canary-key" },
        models: { canary: { name: "Deterministic User Revision Canary", limit: { context: 100000, output: 4096 } } },
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
  let lastState = null
  const diagnostics = () => `provider=${JSON.stringify({ ...provider.stats, heldResponses: provider.stats.heldResponses.size })}\nstate=${JSON.stringify(lastState, null, 2)}\nserver log:\n${serverLog}`

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

    const createdPayload = await api("/session", { method: "POST", body: JSON.stringify({ title: "opencode-goal user revision canary" }) })
    const session = createdPayload?.data ?? createdPayload
    const sessionID = String(session?.id ?? "")
    assert.ok(sessionID, `OpenCode did not create a session: ${JSON.stringify(createdPayload)}`)

    let goalCommandError = null
    const goalCommand = api(`/session/${encodeURIComponent(sessionID)}/command`, {
      method: "POST",
      body: JSON.stringify({ agent: "build", model: "canary/canary", command: "goal", arguments: `${OLD_OBJECTIVE} --max-turns 8` }),
      signal: AbortSignal.timeout(60_000),
    }).catch((error) => {
      goalCommandError = error
      return null
    })

    const planned = await waitForGoal(
      workspace,
      (state) => state.sessionID === sessionID
        && state.revision === 1
        && state.status === "active"
        && state.objective === OLD_OBJECTIVE
        && state.todoPlan?.goalRevision === 1
        && state.todoPlan?.total === OLD_TODOS.length,
      "initial Goal r1 Todo plan",
      diagnostics,
    )
    lastState = planned
    assert.equal(provider.stats.oldTodoCalls, 1)

    await api(`/session/${encodeURIComponent(sessionID)}/command`, {
      method: "POST",
      body: JSON.stringify({ agent: "build", model: "canary/canary", command: "goal", arguments: "pause" }),
      signal: AbortSignal.timeout(20_000),
    })
    const paused = await waitForGoal(
      workspace,
      (state) => state.sessionID === sessionID && state.status === "paused" && state.revision === 1,
      "Goal r1 to pause before foreground revision",
      diagnostics,
    )
    lastState = paused
    await waitFor(() => provider.stats.oldHeldClosed >= 1, "initial Goal provider stream to close on pause", diagnostics)
    await goalCommand.catch(() => undefined)
    if (goalCommandError && !String(goalCommandError).toLowerCase().includes("abort")) throw goalCommandError

    await api(`/session/${encodeURIComponent(sessionID)}/prompt_async`, {
      method: "POST",
      body: JSON.stringify({
        agent: "build",
        model: { providerID: "canary", modelID: "canary" },
        parts: [{ type: "text", text: USER_EXTENSION }],
      }),
      signal: AbortSignal.timeout(20_000),
    })

    const revised = await waitForGoal(
      workspace,
      (state) => state.sessionID === sessionID
        && state.revision === 2
        && state.status === "active"
        && state.objective === `${OLD_OBJECTIVE}\n\nAdditional user instruction:\n${USER_EXTENSION}`
        && state.todoPlan === undefined,
      "foreground user extension to persist as Goal revision 2",
      diagnostics,
      30_000,
    )
    lastState = revised

    assert.equal(provider.stats.revisionCalls, 1, "real executor must call user-revision tool exactly once")
    assert.equal(provider.stats.sawRevisionTool, true, "custom user-revision tool was not exposed to the real OpenCode model request")
    assert.equal(provider.stats.sawRevisionGuidance, true, "foreground user message did not carry revision guidance")
    assert.equal(provider.stats.sawExactUserExtension, true, "foreground user extension was not preserved exactly in the model request")

    const replanned = await waitForGoal(
      workspace,
      (state) => state.sessionID === sessionID
        && state.revision === 2
        && state.status === "active"
        && state.todoPlan?.goalRevision === 2
        && state.todoPlan?.total === NEW_TODOS.length,
      "fresh native Todo plan for Goal revision 2",
      diagnostics,
      30_000,
    )
    lastState = replanned

    assert.equal(provider.stats.sawRevisionToolResult, true, "real host did not feed the Goal revision tool result back into the foreground turn")
    assert.equal(provider.stats.sawRevisedGoalPrompt, true, "Goal did not automatically continue with the revised durable objective")
    assert.equal(provider.stats.revisedTodoCalls, 1, "revised Goal should rebuild its native Todo plan exactly once")
    assert.equal(replanned.todoPlan.pending, 2)
    assert.equal(replanned.todoPlan.inProgress, 1)
    assert.equal(replanned.todoPlan.completed, 0)
    assert.equal(replanned.stalledTurns, 0)
    assert.equal(replanned.budget.maxTokens, 0, "new revisions must preserve the current unbounded cumulative token default")

    console.log(JSON.stringify({
      ok: true,
      platform: process.platform,
      sessionID,
      revision: replanned.revision,
      status: replanned.status,
      oldTodoCalls: provider.stats.oldTodoCalls,
      revisionCalls: provider.stats.revisionCalls,
      revisedTodoCalls: provider.stats.revisedTodoCalls,
      sawRevisionTool: provider.stats.sawRevisionTool,
      sawRevisionGuidance: provider.stats.sawRevisionGuidance,
      sawExactUserExtension: provider.stats.sawExactUserExtension,
      sawRevisionToolResult: provider.stats.sawRevisionToolResult,
      sawRevisedGoalPrompt: provider.stats.sawRevisedGoalPrompt,
      todoPlan: replanned.todoPlan,
      stalledTurns: replanned.stalledTurns,
    }, null, 2))
  } finally {
    await stopProcess(server)
    await provider.close().catch(() => undefined)
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined)
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
