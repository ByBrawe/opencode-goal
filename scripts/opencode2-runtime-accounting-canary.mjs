import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"
import { GoalStore } from "../dist/persistence/store.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const serverFile = path.join(root, "dist", "server.js")
const OPENCODE_BINARY = process.env.OPENCODE2_BINARY || "opencode2"
const USERNAME = "opencode"
const PASSWORD = "opencode-goal-v2-runtime-accounting"
const DIRECT_ENV = "OPENCODE_GOAL_V2_DIRECT_LIFECYCLE"
const AUTONOMOUS_ENV = "OPENCODE_GOAL_V2_AUTONOMOUS"
const CONTROL_TOOL = "opencode_goals_v2_control"
const BUDGET_COMMAND = 'meaningful budget accounting --max-turns 1 --constraint "count only Goal work"'
const EMPTY_COMMAND = 'empty accounting fail-safe --constraint "pause bounded empty retries"'

function appendLog(current, chunk, limit = 160_000) {
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
    if (child.exitCode !== null) throw new Error(`OpenCode 2 server exited before ready.\n${logs()}`)
    const connected = await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port })
      socket.once("connect", () => { socket.destroy(); resolve(true) })
      socket.once("error", () => resolve(false))
      socket.setTimeout(500, () => { socket.destroy(); resolve(false) })
    })
    if (connected) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for OpenCode 2 server on ${port}\n${logs()}`)
}

async function stop(child) {
  if (!child || child.exitCode !== null) return
  child.kill("SIGTERM")
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 5_000)
    child.once("close", () => { clearTimeout(timer); resolve() })
  })
}

async function waitFor(predicate, description, diagnostics, timeoutMs = 120_000) {
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

function latestUserTurn(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (String(message?.role ?? "").toLowerCase() !== "user") continue
    return {
      userText: contentText(message?.content),
      turnText: messages.slice(index).map((item) => `${String(item?.role ?? "")}: ${contentText(item?.content)}`).join("\n"),
    }
  }
  return { userText: "", turnText: "" }
}

function toolNames(body) {
  if (Array.isArray(body?.tools)) {
    return body.tools.map((item) => item?.function?.name ?? item?.name).filter((name) => typeof name === "string")
  }
  if (body?.tools && typeof body.tools === "object") return Object.keys(body.tools)
  return []
}

function headers(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
}

function send(res, value) {
  res.write(`data: ${JSON.stringify(value)}\n\n`)
}

function streamText(res, sequence, text, usage = { prompt_tokens: 23, completion_tokens: 4, total_tokens: 27 }) {
  const id = `chatcmpl-v2-accounting-text-${sequence}`
  const created = Math.floor(Date.now() / 1000)
  headers(res)
  if (text !== undefined) {
    send(res, {
      id, object: "chat.completion.chunk", created, model: "canary",
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    })
  } else {
    send(res, {
      id, object: "chat.completion.chunk", created, model: "canary",
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    })
  }
  send(res, {
    id, object: "chat.completion.chunk", created, model: "canary",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage,
  })
  res.end("data: [DONE]\n\n")
}

function streamControl(res, sequence, command) {
  const id = `chatcmpl-v2-accounting-control-${sequence}`
  const created = Math.floor(Date.now() / 1000)
  headers(res)
  send(res, {
    id, object: "chat.completion.chunk", created, model: "canary",
    choices: [{
      index: 0,
      delta: {
        role: "assistant",
        tool_calls: [{
          index: 0,
          id: `call-v2-accounting-${sequence}`,
          type: "function",
          function: { name: CONTROL_TOOL, arguments: "" },
        }],
      },
      finish_reason: null,
    }],
  })
  send(res, {
    id, object: "chat.completion.chunk", created, model: "canary",
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          function: { arguments: JSON.stringify({ command }) },
        }],
      },
      finish_reason: null,
    }],
  })
  send(res, {
    id, object: "chat.completion.chunk", created, model: "canary",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 37, completion_tokens: 8, total_tokens: 45 },
  })
  res.end("data: [DONE]\n\n")
}

function startProvider() {
  const stats = { requests: [] }
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
    const current = latestUserTurn(body)
    const tools = toolNames(body)
    const hasControl = tools.includes(CONTROL_TOOL)
    const consumed = /single-use capability is consumed/i.test(current.turnText)
    const autonomous = current.userText.includes("Continue working toward the active OpenCode goal.")
    const budget = current.userText.includes("meaningful budget accounting")
    const empty = current.userText.includes("empty accounting fail-safe")

    stats.requests.push({
      sequence,
      userText: current.userText,
      hasControl,
      consumed,
      autonomous,
      budget,
      empty,
    })

    if (hasControl && !consumed && (current.userText.includes(BUDGET_COMMAND) || current.userText.includes(EMPTY_COMMAND))) {
      streamControl(res, sequence, current.userText.includes(BUDGET_COMMAND) ? BUDGET_COMMAND : EMPTY_COMMAND)
      return
    }

    if (autonomous && budget) {
      streamText(res, sequence, "MEANINGFUL_GOAL_ACCOUNTING", {
        prompt_tokens: 17,
        completion_tokens: 4,
        total_tokens: 21,
      })
      return
    }

    if (autonomous && empty) {
      streamText(res, sequence, undefined, {
        prompt_tokens: 13,
        completion_tokens: 0,
        total_tokens: 13,
      })
      return
    }

    streamText(res, sequence, `LIFECYCLE_SETTLED_${sequence}`)
  })

  return {
    stats,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", resolve)
      })
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("provider did not bind")
      return address.port
    },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

function commandNames(payload) {
  const data = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : []
  return new Set(data.map((item) => item?.name ?? item?.id).filter((name) => typeof name === "string"))
}

async function main() {
  assert.equal(process.platform, "linux", "the exact V2 runtime accounting canary is intentionally Ubuntu-only")

  const workspace = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-v2-accounting-"))
  const home = path.join(workspace, ".home")
  const pluginDir = path.join(workspace, ".opencode", "plugins")
  const bridge = path.join(pluginDir, "opencode-goal-server.js")
  const provider = startProvider()
  const providerPort = await provider.listen()
  const store = new GoalStore(workspace)

  let server
  let serverLog = ""
  let latestCommands = new Set()
  const sessions = {}

  await Promise.all([
    mkdir(pluginDir, { recursive: true }),
    mkdir(path.join(home, ".config"), { recursive: true }),
    mkdir(path.join(home, ".local", "share"), { recursive: true }),
    mkdir(path.join(home, ".local", "state"), { recursive: true }),
    mkdir(path.join(home, ".cache"), { recursive: true }),
  ])

  await writeFile(bridge, `export { default } from ${JSON.stringify(pathToFileURL(serverFile).href)}\n`, "utf8")
  await writeFile(path.join(workspace, "README.md"), "# V2 runtime accounting parity\n", "utf8")
  await writeFile(path.join(workspace, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "canary/canary",
    providers: {
      canary: {
        name: "V2 Accounting Canary",
        package: "@opencode-ai/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${providerPort}/v1` },
        models: {
          canary: {
            name: "V2 Accounting Canary",
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            limit: { context: 100000, output: 4096 },
          },
        },
      },
    },
  }, null, 2), "utf8")

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

  const diagnostics = async () => [
    `sessions=${JSON.stringify(sessions)}`,
    `budgetGoal=${JSON.stringify(sessions.budget ? await store.load(sessions.budget).catch((error) => ({ error: String(error) })) : null)}`,
    `emptyGoal=${JSON.stringify(sessions.empty ? await store.load(sessions.empty).catch((error) => ({ error: String(error) })) : null)}`,
    `provider=${JSON.stringify(provider.stats)}`,
    `serverExit=${server?.exitCode}`,
    `serverLog=${serverLog}`,
  ].join("\n")

  try {
    const version = String(execFileSync(OPENCODE_BINARY, ["--version"], {
      cwd: workspace, env, encoding: "utf8", windowsHide: true,
    })).trim()
    assert.ok(version.includes("2.0.11"), `expected exact OpenCode 2.0.11, got ${version}`)

    const port = await reservePort()
    server = spawn(OPENCODE_BINARY, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: workspace, env, windowsHide: true,
    })
    server.stdout?.on("data", (chunk) => { serverLog = appendLog(serverLog, chunk) })
    server.stderr?.on("data", (chunk) => { serverLog = appendLog(serverLog, chunk) })
    await waitForTcp(port, server, () => serverLog)

    const baseURL = `http://127.0.0.1:${port}`
    const authorization = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64")}`
    const request = async (pathname, init = {}, timeoutMs = 120_000) => {
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
      let body
      try { body = text ? JSON.parse(text) : null } catch { body = text }
      return { ok: response.ok, status: response.status, body, text }
    }

    await waitFor(async () => {
      const ready = await request("/api/command", { method: "GET" }, 5_000).catch(() => null)
      if (!ready?.ok) return false
      latestCommands = commandNames(ready.body)
      return latestCommands.has("goal")
    }, "plugin-aware Goal command", diagnostics, 30_000)

    const createSession = async (key, title) => {
      const created = await request("/api/session", {
        method: "POST",
        body: JSON.stringify({ title }),
      })
      assert.ok(created.ok, `session create failed: ${created.status} ${created.text}`)
      const id = String((created.body?.data ?? created.body)?.id ?? "")
      assert.ok(id)
      sessions[key] = id
      return id
    }

    const runGoal = async (sessionID, command) => {
      const response = await request(`/api/session/${encodeURIComponent(sessionID)}/command`, {
        method: "POST",
        body: JSON.stringify({ name: "goal", text: command }),
      }, 180_000)
      assert.ok(response.ok, `/goal ${command} failed: ${response.status} ${response.text}\n${await diagnostics()}`)
    }

    const budgetSession = await createSession("budget", "V2 budget accounting")
    const budgetCommand = runGoal(budgetSession, BUDGET_COMMAND)
    const budgetLimited = await waitFor(async () => {
      const goal = await store.load(budgetSession)
      return goal?.status === "budget_limited" ? goal : null
    }, "meaningful Goal-owned step reaches maxTurns=1", diagnostics)
    await budgetCommand

    assert.equal(budgetLimited.usage.turns, 1, "direct lifecycle create must not count as a Goal work turn")
    assert.equal(budgetLimited.usage.seenMessageIDs.length, 1)
    assert.ok(budgetLimited.usage.tokens > 0)
    assert.equal(budgetLimited.emptyTurnCount, undefined)
    assert.ok((budgetLimited.execution?.modelContext?.lastRequestTokens ?? 0) > 0)
    assert.match(budgetLimited.stopReason ?? "", /turns 1 \/ 1/)
    const budgetAutonomous = provider.stats.requests.filter((item) => item.autonomous && item.budget)
    assert.equal(budgetAutonomous.length, 1)

    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(
      provider.stats.requests.filter((item) => item.autonomous && item.budget).length,
      1,
      "budget-limited Goal must not dispatch another autonomous turn",
    )

    const emptySession = await createSession("empty", "V2 empty-turn accounting")
    const emptyCommand = runGoal(emptySession, EMPTY_COMMAND)
    const emptyPaused = await waitFor(async () => {
      const goal = await store.load(emptySession)
      return goal?.status === "paused" && goal.emptyTurnCount === 2 ? goal : null
    }, "two consecutive empty Goal-owned assistant steps", diagnostics)
    await emptyCommand

    assert.equal(emptyPaused.usage.turns, 0, "empty Goal-owned turns refund only the logical turn count")
    assert.equal(emptyPaused.usage.seenMessageIDs.length, 2)
    assert.ok(emptyPaused.usage.tokens > 0, "empty turns still preserve token accounting")
    assert.equal(emptyPaused.stalledTurns, 0, "dedicated empty-turn policy owns the retry instead of generic stall counting")
    assert.equal(emptyPaused.skipNextStallCheck, undefined)
    assert.match(emptyPaused.stopReason ?? "", /2 consecutive Goal-owned assistant turns completed without meaningful/)
    const emptyAutonomous = provider.stats.requests.filter((item) => item.autonomous && item.empty)
    assert.equal(emptyAutonomous.length, 2)

    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(
      provider.stats.requests.filter((item) => item.autonomous && item.empty).length,
      2,
      "paused empty-turn Goal must not dispatch a third autonomous retry",
    )

    assert.equal(server.exitCode, null, `OpenCode 2 exited during runtime accounting canary\n${await diagnostics()}`)
    console.log(JSON.stringify({
      ok: true,
      version,
      budget: {
        sessionID: budgetSession,
        status: budgetLimited.status,
        usage: budgetLimited.usage,
        modelContext: budgetLimited.execution?.modelContext,
        autonomousTurns: budgetAutonomous.length,
      },
      empty: {
        sessionID: emptySession,
        status: emptyPaused.status,
        usage: emptyPaused.usage,
        emptyTurnCount: emptyPaused.emptyTurnCount,
        stalledTurns: emptyPaused.stalledTurns,
        autonomousTurns: emptyAutonomous.length,
      },
    }, null, 2))
  } finally {
    await stop(server)
    await provider.close().catch(() => undefined)
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined)
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
