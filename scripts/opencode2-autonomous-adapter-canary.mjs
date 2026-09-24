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
const SERVER_USERNAME = "opencode"
const SERVER_PASSWORD = "opencode-goal-v2-autonomous"
const DIRECT_ENV = "OPENCODE_GOAL_V2_DIRECT_LIFECYCLE"
const AUTONOMOUS_ENV = "OPENCODE_GOAL_V2_AUTONOMOUS"
const CONTROL_TOOL = "opencode_goals_v2_control"
const READ_ONLY_TOOL = "opencode_goals_v2_get"
const CREATE_COMMAND = 'ship autonomous v2 parity --constraint "do not invent progress"'

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
    if (child.exitCode !== null) throw new Error(`OpenCode 2 server exited before ready.\n${logs()}`)
    const connected = await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port })
      socket.once("connect", () => {
        socket.destroy()
        resolve(true)
      })
      socket.once("error", () => resolve(false))
      socket.setTimeout(500, () => {
        socket.destroy()
        resolve(false)
      })
    })
    if (connected) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for OpenCode 2 server on ${port}\n${logs()}`)
}

async function stopProcess(child, timeoutMs = 5_000) {
  if (!child || child.exitCode !== null) return
  child.kill("SIGTERM")
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve()
    const timer = setTimeout(resolve, timeoutMs)
    child.once("close", () => {
      clearTimeout(timer)
      resolve()
    })
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

function latestUserTurn(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (String(message?.role || "").toLowerCase() !== "user") continue
    return {
      userText: contentText(message?.content),
      turnText: messages.slice(index).map((item) => `${String(item?.role || "")}: ${contentText(item?.content)}`).join("\n"),
    }
  }
  return { userText: "", turnText: "" }
}

function toolNames(body) {
  if (Array.isArray(body?.tools)) {
    return body.tools
      .map((item) => item?.function?.name ?? item?.name)
      .filter((name) => typeof name === "string")
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

function writeSse(res, value) {
  res.write(`data: ${JSON.stringify(value)}\n\n`)
}

function streamText(res, sequence, text) {
  const id = `chatcmpl-goal-v2-autonomous-${sequence}`
  const created = Math.floor(Date.now() / 1000)
  streamHeaders(res)
  writeSse(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model: "canary",
    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
  })
  writeSse(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model: "canary",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 },
  })
  res.end("data: [DONE]\n\n")
}

function streamControlTool(res, sequence) {
  const id = `chatcmpl-goal-v2-autonomous-control-${sequence}`
  const created = Math.floor(Date.now() / 1000)
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
        tool_calls: [{
          index: 0,
          id: `call-goal-v2-autonomous-${sequence}`,
          type: "function",
          function: { name: CONTROL_TOOL, arguments: "" },
        }],
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
      delta: {
        tool_calls: [{
          index: 0,
          function: { arguments: JSON.stringify({ command: CREATE_COMMAND }) },
        }],
      },
      finish_reason: null,
    }],
  })
  writeSse(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model: "canary",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 },
  })
  res.end("data: [DONE]\n\n")
}

function startProvider() {
  const stats = { requests: [] }
  let releaseFirstAutonomous
  const firstAutonomousGate = new Promise((resolve) => { releaseFirstAutonomous = resolve })
  let firstAutonomousHeld = false

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if (req.method === "GET" && url.pathname.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({
        object: "list",
        data: [{ id: "canary", object: "model", owned_by: "canary" }],
      }))
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
    const sequence = stats.requests.length + 1
    const current = latestUserTurn(body)
    const tools = toolNames(body)
    const hasControlTool = tools.includes(CONTROL_TOOL)
    const hasReadOnlyTool = tools.includes(READ_ONLY_TOOL)
    const sawConsumedResult = /single-use capability is consumed/i.test(current.turnText)
    const autonomous = current.userText.includes("Continue working toward the active OpenCode goal.")

    stats.requests.push({
      sequence,
      currentUserText: current.userText,
      tools,
      hasControlTool,
      hasReadOnlyTool,
      sawConsumedResult,
      autonomous,
    })

    if (hasControlTool && current.userText.includes(CREATE_COMMAND) && !sawConsumedResult) {
      streamControlTool(res, sequence)
      return
    }

    if (autonomous && !firstAutonomousHeld) {
      firstAutonomousHeld = true
      await firstAutonomousGate
    }

    streamText(
      res,
      sequence,
      autonomous
        ? `AUTONOMOUS_GOAL_TURN_${stats.requests.filter((item) => item.autonomous).length}`
        : `LIFECYCLE_CONTINUATION_${sequence}`,
    )
  })

  return {
    stats,
    releaseFirstAutonomous() {
      releaseFirstAutonomous?.()
    },
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", resolve)
      })
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("deterministic provider did not bind")
      return address.port
    },
    async close() {
      releaseFirstAutonomous?.()
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

function commandNames(payload) {
  const data = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : []
  return new Set(data.map((item) => item?.name ?? item?.id).filter((name) => typeof name === "string"))
}

async function main() {
  assert.equal(process.platform, "linux", "the exact OpenCode 2 autonomous adapter canary is intentionally Ubuntu-only")

  const workspace = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-v2-autonomous-"))
  const home = path.join(workspace, ".home")
  const pluginDir = path.join(workspace, ".opencode", "plugins")
  const bridge = path.join(pluginDir, "opencode-goal-server.js")
  const provider = startProvider()
  const providerPort = await provider.listen()

  let server
  let serverLog = ""
  let sessionID = ""
  let latestCommands = new Set()
  const goalStore = new GoalStore(workspace)

  await Promise.all([
    mkdir(pluginDir, { recursive: true }),
    mkdir(path.join(home, ".config"), { recursive: true }),
    mkdir(path.join(home, ".local", "share"), { recursive: true }),
    mkdir(path.join(home, ".local", "state"), { recursive: true }),
    mkdir(path.join(home, ".cache"), { recursive: true }),
  ])

  await writeFile(bridge, `export { default } from ${JSON.stringify(pathToFileURL(serverFile).href)}\n`, "utf8")
  await writeFile(path.join(workspace, "README.md"), "# OpenCode Goal V2 autonomous adapter canary\n", "utf8")
  await writeFile(path.join(workspace, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "canary/canary",
    providers: {
      canary: {
        name: "Deterministic OpenCode Goal V2 Autonomous Canary",
        package: "@opencode-ai/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${providerPort}/v1` },
        models: {
          canary: {
            name: "Deterministic OpenCode Goal V2 Autonomous Canary",
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            limit: { context: 100000, output: 4096 },
          },
        },
      },
    },
  }, null, 2)}\n`, "utf8")

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
    OPENCODE_SERVER_USERNAME: SERVER_USERNAME,
    OPENCODE_SERVER_PASSWORD: SERVER_PASSWORD,
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    CI: "true",
  }

  const diagnostics = async () => {
    const goal = sessionID ? await goalStore.load(sessionID).catch((error) => ({ error: String(error) })) : null
    return [
      `sessionID=${sessionID || "none"}`,
      `commands=${JSON.stringify([...latestCommands])}`,
      `goal=${JSON.stringify(goal)}`,
      `provider=${JSON.stringify(provider.stats)}`,
      `serverExit=${server?.exitCode}`,
      `serverLog=${serverLog}`,
    ].join("\n")
  }

  try {
    const version = String(execFileSync(OPENCODE_BINARY, ["--version"], {
      cwd: workspace,
      env,
      encoding: "utf8",
      windowsHide: true,
    })).trim()
    assert.ok(version.includes("2.0.11"), `expected exact OpenCode 2.0.11, got: ${version}`)

    const port = await reservePort()
    server = spawn(OPENCODE_BINARY, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: workspace,
      env,
      windowsHide: true,
    })
    server.stdout?.on("data", (chunk) => { serverLog = appendLog(serverLog, chunk) })
    server.stderr?.on("data", (chunk) => { serverLog = appendLog(serverLog, chunk) })
    await waitForTcp(port, server, () => serverLog)

    const baseURL = `http://127.0.0.1:${port}`
    const authorization = `Basic ${Buffer.from(`${SERVER_USERNAME}:${SERVER_PASSWORD}`).toString("base64")}`
    const request = async (pathname, init = {}, timeoutMs = 30_000) => {
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
      if (text) {
        try { body = JSON.parse(text) } catch { body = text }
      }
      return { ok: response.ok, status: response.status, body, text }
    }

    await waitFor(async () => {
      const response = await request("/api/command", { method: "GET" }, 5_000).catch(() => null)
      if (!response?.ok) return false
      latestCommands = commandNames(response.body)
      return latestCommands.has("goal")
    }, "exact OpenCode 2 plugin-aware command surface", diagnostics, 30_000)

    const created = await request("/api/session", {
      method: "POST",
      body: JSON.stringify({ title: "OpenCode Goal V2 autonomous adapter" }),
    })
    assert.ok(created.ok, `session create failed: HTTP ${created.status} ${created.text}\n${await diagnostics()}`)
    sessionID = String((created.body?.data ?? created.body)?.id ?? "")
    assert.ok(sessionID, `session ID missing: ${created.text}`)

    const commandPromise = request(`/api/session/${encodeURIComponent(sessionID)}/command`, {
      method: "POST",
      body: JSON.stringify({ name: "goal", text: CREATE_COMMAND }),
    }, 120_000)

    await waitFor(
      () => provider.stats.requests.some((item) => item.autonomous),
      "first production-adapter autonomous Goal request",
      diagnostics,
      60_000,
    )

    const beforeFirstGoalTurn = await waitFor(async () => {
      const goal = await goalStore.load(sessionID)
      return goal?.status === "active" ? goal : null
    }, "persisted active Goal before first autonomous response", diagnostics)
    assert.equal(beforeFirstGoalTurn.stalledTurns, 0, "direct lifecycle command terminal must not count as a Goal work turn")
    assert.equal(beforeFirstGoalTurn.progressRevision, 0)

    const firstAutonomous = provider.stats.requests.find((item) => item.autonomous)
    assert.ok(firstAutonomous)
    assert.equal(firstAutonomous.hasControlTool, false, "autonomous Goal work must not inherit direct lifecycle mutation authority")
    assert.equal(firstAutonomous.hasReadOnlyTool, true, "autonomous Goal work must retain read-only Goal inspection")

    provider.releaseFirstAutonomous()
    const commandResult = await commandPromise
    assert.ok(commandResult.ok, `direct Goal create failed: HTTP ${commandResult.status} ${commandResult.text}\n${await diagnostics()}`)

    const paused = await waitFor(async () => {
      const goal = await goalStore.load(sessionID)
      return goal?.status === "paused" && goal.stalledTurns === 3 ? goal : null
    }, "production V2 coordinator no-progress pause", diagnostics, 120_000)
    assert.match(paused.stopReason ?? "", /3 continuation turns without host-observed progress/)

    const autonomousRequests = provider.stats.requests.filter((item) => item.autonomous)
    assert.equal(autonomousRequests.length, 3, `expected exactly three owned autonomous Goal turns\n${await diagnostics()}`)
    assert.ok(autonomousRequests.every((item) => !item.hasControlTool), "mutating lifecycle control leaked into autonomous Goal work")
    assert.ok(autonomousRequests.every((item) => item.hasReadOnlyTool), "read-only Goal inspection disappeared from autonomous Goal work")

    await new Promise((resolve) => setTimeout(resolve, 750))
    assert.equal(
      provider.stats.requests.filter((item) => item.autonomous).length,
      3,
      "paused third Goal turn must not dispatch a fourth autonomous request",
    )
    assert.equal(server.exitCode, null, `OpenCode 2 server exited during autonomous canary\n${await diagnostics()}`)

    console.log(JSON.stringify({
      ok: true,
      version,
      sessionID,
      lifecycleCommandDidNotCountAsGoalTurn: beforeFirstGoalTurn.stalledTurns === 0,
      autonomousTurns: autonomousRequests.length,
      finalStatus: paused.status,
      finalStalledTurns: paused.stalledTurns,
      directControlHiddenDuringAutonomousWork: autonomousRequests.every((item) => !item.hasControlTool),
      readOnlyGoalToolPresent: autonomousRequests.every((item) => item.hasReadOnlyTool),
      providerRequests: provider.stats.requests,
    }, null, 2))
  } finally {
    provider.releaseFirstAutonomous()
    await stopProcess(server)
    await provider.close().catch(() => undefined)
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined)
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
