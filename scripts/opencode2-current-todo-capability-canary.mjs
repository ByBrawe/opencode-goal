import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const serverFile = path.join(root, "dist", "server.js")
const OPENCODE_BINARY = process.env.OPENCODE2_BINARY || "opencode2"
const USERNAME = "opencode"
const PASSWORD = "opencode-goal-v2-current-todo"
const DIRECT_ENV = "OPENCODE_GOAL_V2_DIRECT_LIFECYCLE"
const AUTONOMOUS_ENV = "OPENCODE_GOAL_V2_AUTONOMOUS"
const CONTROL_TOOL = "opencode_goals_v2_control"
const TODO_TOOL = "todowrite"
const COMMAND = "prove current V2 native Todo capability --max-turns 1"
const TODOS = [
  { content: "Inspect current V2 tool surface", status: "in_progress", priority: "high" },
  { content: "Prove native Todo call settles", status: "pending", priority: "medium" },
]

function appendLog(current, chunk, limit = 120_000) {
  return (current + String(chunk)).slice(-limit)
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

async function stopProcess(child, timeoutMs = 5_000) {
  if (!child || child.exitCode !== null) return
  child.kill("SIGTERM")
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    child.once("close", () => { clearTimeout(timer); resolve() })
  })
}

async function waitFor(predicate, description, diagnostics, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for ${description}\n${await diagnostics()}`)
}

function contentText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((part) => {
    if (typeof part === "string") return part
    if (typeof part?.text === "string") return part.text
    if (typeof part?.content === "string") return part.content
    return ""
  }).join("\n")
}

function latestTurn(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  let start = -1
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (String(messages[i]?.role ?? "").toLowerCase() === "user") {
      start = i
      break
    }
  }
  const turn = messages.slice(Math.max(0, start))
  return {
    userText: start >= 0 ? contentText(messages[start]?.content) : "",
    turnText: turn.map((item) => `${String(item?.role ?? "")}: ${contentText(item?.content)}`).join("\n"),
  }
}

function toolNames(body) {
  if (Array.isArray(body?.tools)) {
    return body.tools.map((item) => item?.function?.name ?? item?.name).filter((item) => typeof item === "string")
  }
  if (body?.tools && typeof body.tools === "object") return Object.keys(body.tools)
  return []
}

function streamHeaders(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
}

function send(res, value) {
  res.write(`data: ${JSON.stringify(value)}\n\n`)
}

function streamTool(res, sequence, name, args) {
  const id = `chatcmpl-v2-current-todo-${sequence}`
  const created = Math.floor(Date.now() / 1000)
  streamHeaders(res)
  send(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model: "canary",
    choices: [{
      index: 0,
      delta: {
        role: "assistant",
        content: null,
        tool_calls: [{
          index: 0,
          id: `call-v2-current-todo-${sequence}`,
          type: "function",
          function: { name, arguments: "" },
        }],
      },
      finish_reason: null,
    }],
  })
  send(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model: "canary",
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          function: { arguments: JSON.stringify(args) },
        }],
      },
      finish_reason: null,
    }],
  })
  send(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model: "canary",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 35, completion_tokens: 8, total_tokens: 43 },
  })
  res.end("data: [DONE]\n\n")
}

function streamText(res, sequence, text) {
  const id = `chatcmpl-v2-current-todo-text-${sequence}`
  const created = Math.floor(Date.now() / 1000)
  streamHeaders(res)
  send(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model: "canary",
    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
  })
  send(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model: "canary",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 25, completion_tokens: 4, total_tokens: 29 },
  })
  res.end("data: [DONE]\n\n")
}

function startProvider() {
  const stats = { requests: [], todoCalls: 0 }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if (req.method === "GET" && url.pathname.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ object: "list", data: [{ id: "canary", object: "model", owned_by: "canary" }] }))
      return
    }
    if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" })
      res.end("{}")
      return
    }

    let raw = ""
    for await (const chunk of req) raw += String(chunk)
    const body = raw ? JSON.parse(raw) : {}
    const sequence = stats.requests.length + 1
    const tools = toolNames(body)
    const turn = latestTurn(body)
    const autonomous = turn.userText.includes("Continue working toward the active OpenCode goal.")
    const controlConsumed = /single-use capability is consumed/i.test(turn.turnText)
    const todoSettled = /Inspect current V2 tool surface|Prove native Todo call settles/.test(turn.turnText)
      && /tool|todo/i.test(turn.turnText)

    stats.requests.push({ sequence, tools, autonomous, userText: turn.userText, turnText: turn.turnText })

    if (tools.includes(CONTROL_TOOL) && turn.userText.includes(COMMAND) && !controlConsumed) {
      streamTool(res, sequence, CONTROL_TOOL, { command: COMMAND })
      return
    }

    if (autonomous && !todoSettled && stats.todoCalls === 0) {
      assert.ok(
        tools.includes(TODO_TOOL),
        `current OpenCode 2 Goal execution did not expose todowrite: ${JSON.stringify(tools)}`,
      )
      stats.todoCalls += 1
      streamTool(res, sequence, TODO_TOOL, { todos: TODOS })
      return
    }

    streamText(res, sequence, autonomous ? "CURRENT_V2_TODO_TOOL_SETTLED" : "LIFECYCLE_SETTLED")
  })

  return {
    stats,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", resolve)
      })
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("provider failed to bind")
      return address.port
    },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

async function main() {
  assert.equal(process.platform, "linux")
  const workspace = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-v2-current-todo-"))
  const home = path.join(workspace, ".home")
  const pluginDir = path.join(workspace, ".opencode", "plugins")
  const provider = startProvider()
  const providerPort = await provider.listen()
  let child
  let log = ""
  let sessionID = ""

  await Promise.all([
    mkdir(pluginDir, { recursive: true }),
    mkdir(path.join(home, ".config"), { recursive: true }),
    mkdir(path.join(home, ".local", "share"), { recursive: true }),
    mkdir(path.join(home, ".local", "state"), { recursive: true }),
    mkdir(path.join(home, ".cache"), { recursive: true }),
  ])

  await writeFile(
    path.join(pluginDir, "opencode-goal-server.js"),
    `export { default } from ${JSON.stringify(pathToFileURL(serverFile).href)}\n`,
    "utf8",
  )
  await writeFile(path.join(workspace, "README.md"), "# Current V2 Todo capability proof\n", "utf8")
  await writeFile(path.join(workspace, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "canary/canary",
    providers: {
      canary: {
        name: "Current V2 Todo Capability",
        package: "@opencode-ai/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${providerPort}/v1` },
        models: {
          canary: {
            name: "Current V2 Todo Capability",
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            limit: { context: 100000, output: 4096 },
          },
        },
      },
    },
  }, null, 2) + "\n", "utf8")

  execFileSync("git", ["init", "--quiet", workspace], { stdio: "ignore" })
  execFileSync("git", ["-C", workspace, "config", "user.email", "opencode-goal-ci@example.invalid"], { stdio: "ignore" })
  execFileSync("git", ["-C", workspace, "config", "user.name", "OpenCode Goal CI"], { stdio: "ignore" })
  execFileSync("git", ["-C", workspace, "add", "."], { stdio: "ignore" })
  execFileSync("git", ["-C", workspace, "commit", "--quiet", "-m", "init"], { stdio: "ignore" })

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    [DIRECT_ENV]: "1",
    [AUTONOMOUS_ENV]: "1",
    OPENCODE_SERVER_USERNAME: USERNAME,
    OPENCODE_SERVER_PASSWORD: PASSWORD,
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    CI: "true",
  }

  const diagnostics = () => [
    `sessionID=${sessionID || "none"}`,
    `provider=${JSON.stringify(provider.stats)}`,
    `serverExit=${child?.exitCode}`,
    `serverLog=${log}`,
  ].join("\n")

  try {
    const version = String(execFileSync(OPENCODE_BINARY, ["--version"], {
      cwd: workspace,
      env,
      encoding: "utf8",
    })).trim()
    assert.ok(version.includes("2.0.15"), `expected OpenCode 2.0.15, got ${version}`)

    const port = await reservePort()
    child = spawn(OPENCODE_BINARY, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: workspace,
      env,
      windowsHide: true,
    })
    child.stdout?.on("data", (chunk) => { log = appendLog(log, chunk) })
    child.stderr?.on("data", (chunk) => { log = appendLog(log, chunk) })
    await waitForTcp(port, child, () => log)

    const baseURL = `http://127.0.0.1:${port}`
    const authorization = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64")}`
    const request = async (pathname, init = {}, timeoutMs = 90_000) => {
      const response = await fetch(`${baseURL}${pathname}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          "x-opencode-directory": workspace,
          authorization,
          ...(init.headers ?? {}),
        },
        signal: init.signal ?? AbortSignal.timeout(timeoutMs),
      })
      const text = await response.text()
      let body = null
      try { body = text ? JSON.parse(text) : null } catch { body = text }
      return { ok: response.ok, status: response.status, body, text }
    }

    await waitFor(async () => {
      const response = await request("/api/command", { method: "GET" }, 5_000).catch(() => null)
      const data = Array.isArray(response?.body?.data) ? response.body.data : Array.isArray(response?.body) ? response.body : []
      return response?.ok && data.some((item) => (item?.name ?? item?.id) === "goal")
    }, "Goal command registration", diagnostics, 30_000)

    const created = await request("/api/session", {
      method: "POST",
      body: JSON.stringify({ title: "Current V2 Todo capability" }),
    })
    assert.ok(created.ok, `session create failed: ${created.status} ${created.text}\n${diagnostics()}`)
    sessionID = String((created.body?.data ?? created.body)?.id ?? "")
    assert.ok(sessionID)

    const result = await request(`/api/session/${encodeURIComponent(sessionID)}/command`, {
      method: "POST",
      body: JSON.stringify({ name: "goal", text: COMMAND }),
    }, 120_000)
    assert.ok(result.ok, `Goal command failed: ${result.status} ${result.text}\n${diagnostics()}`)

    await waitFor(
      () => provider.stats.todoCalls === 1 && provider.stats.requests.some((item) => item.autonomous && item.turnText.includes("todowrite")),
      "current V2 native Todo tool settlement",
      diagnostics,
      90_000,
    )

    const autonomous = provider.stats.requests.filter((item) => item.autonomous)
    assert.ok(autonomous.length >= 2)
    assert.ok(autonomous[0].tools.includes(TODO_TOOL))

    console.log(JSON.stringify({
      ok: true,
      version,
      sessionID,
      todoCalls: provider.stats.todoCalls,
      firstAutonomousTools: autonomous[0].tools,
      providerRequests: provider.stats.requests,
    }, null, 2))
  } finally {
    await stopProcess(child)
    await provider.close().catch(() => undefined)
    await rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }).catch(() => undefined)
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
