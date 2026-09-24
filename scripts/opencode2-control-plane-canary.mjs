import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"
import { GoalSequenceStore } from "../dist/persistence/sequence-store.js"
import { GoalStore } from "../dist/persistence/store.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const serverFile = path.join(root, "dist", "server.js")
const OPENCODE_BINARY = process.env.OPENCODE2_BINARY || "opencode2"
const SERVER_USERNAME = "opencode"
const SERVER_PASSWORD = "opencode-goal-v2-control-plane"
const DIRECT_ENV = "OPENCODE_GOAL_V2_DIRECT_LIFECYCLE"
const CONTROL_TOOL = "opencode_goals_v2_control"

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

async function waitFor(predicate, description, diagnostics, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
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
    return body.tools.map((item) => item?.function?.name ?? item?.name).filter((name) => typeof name === "string")
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

function streamText(res, sequence, text = `CONTROL_PLANE_PROVIDER_${sequence}`) {
  const id = `chatcmpl-goal-v2-control-plane-${sequence}`
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

function streamControlTool(res, sequence, command) {
  const id = `chatcmpl-goal-v2-control-plane-tool-${sequence}`
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
          id: `call-goal-v2-control-plane-${sequence}`,
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
          function: { arguments: JSON.stringify({ command }) },
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
    usage: { prompt_tokens: 45, completion_tokens: 8, total_tokens: 53 },
  })
  res.end("data: [DONE]\n\n")
}

function startProvider() {
  const stats = { requests: [] }
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
    const sawConsumedResult = /single-use (?:host )?capability is consumed/i.test(current.turnText)
    const toolCommand = hasControlTool && !sawConsumedResult ? current.userText.trim() : ""

    stats.requests.push({
      sequence,
      currentUserText: current.userText,
      tools,
      hasControlTool,
      sawConsumedResult,
      toolCommand,
    })

    if (toolCommand) {
      streamControlTool(res, sequence, toolCommand)
      return
    }
    streamText(res, sequence)
  })

  return {
    stats,
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
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

function commandNames(payload) {
  const data = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : []
  return new Set(data.map((item) => item?.name ?? item?.id).filter((name) => typeof name === "string"))
}

async function main() {
  assert.equal(process.platform, "linux", "the exact OpenCode 2 control-plane canary is intentionally Ubuntu-only")

  const workspace = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-v2-control-plane-"))
  const home = path.join(workspace, ".home")
  const pluginDir = path.join(workspace, ".opencode", "plugins")
  const bridge = path.join(pluginDir, "opencode-goal-server.js")
  const provider = startProvider()
  const providerPort = await provider.listen()

  let server
  let serverLog = ""
  let sessionID = ""
  let latestCommands = new Set()
  const store = new GoalStore(workspace)
  const sequences = new GoalSequenceStore(workspace)

  await Promise.all([
    mkdir(pluginDir, { recursive: true }),
    mkdir(path.join(home, ".config"), { recursive: true }),
    mkdir(path.join(home, ".local", "share"), { recursive: true }),
    mkdir(path.join(home, ".local", "state"), { recursive: true }),
    mkdir(path.join(home, ".cache"), { recursive: true }),
  ])

  await writeFile(bridge, `export { default } from ${JSON.stringify(pathToFileURL(serverFile).href)}\n`, "utf8")
  await writeFile(path.join(workspace, "README.md"), "# OpenCode Goal V2 control-plane parity canary\n", "utf8")
  await writeFile(path.join(workspace, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "canary/canary",
    providers: {
      canary: {
        name: "Deterministic V2 Goal Control Plane",
        package: "@opencode-ai/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${providerPort}/v1` },
        models: {
          canary: {
            name: "Deterministic V2 Goal Control Plane",
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
    OPENCODE_SERVER_USERNAME: SERVER_USERNAME,
    OPENCODE_SERVER_PASSWORD: SERVER_PASSWORD,
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    CI: "true",
  }

  const diagnostics = async () => [
    `sessionID=${sessionID || "none"}`,
    `goal=${JSON.stringify(sessionID ? await store.load(sessionID).catch((error) => ({ error: String(error) })) : null)}`,
    `queue=${JSON.stringify(sessionID ? await sequences.load(sessionID).catch((error) => ({ error: String(error) })) : null)}`,
    `provider=${JSON.stringify(provider.stats)}`,
    `serverExit=${server?.exitCode}`,
    `serverLog=${serverLog}`,
  ].join("\n")

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
    const request = async (pathname, init = {}, timeoutMs = 60_000) => {
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

    const readyDeadline = Date.now() + 30_000
    while (Date.now() < readyDeadline) {
      const response = await request("/api/command", { method: "GET" }, 5_000).catch(() => null)
      if (response?.ok) {
        latestCommands = commandNames(response.body)
        if (latestCommands.has("goal")) break
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.ok(latestCommands.has("goal"), `goal command never registered\n${await diagnostics()}`)

    const created = await request("/api/session", {
      method: "POST",
      body: JSON.stringify({ title: "V2 control-plane parity" }),
    })
    assert.ok(created.ok, `session create failed: HTTP ${created.status} ${created.text}`)
    sessionID = String((created.body?.data ?? created.body)?.id ?? "")
    assert.ok(sessionID)

    const command = async (text) => {
      const before = provider.stats.requests.length
      const response = await request(`/api/session/${encodeURIComponent(sessionID)}/command`, {
        method: "POST",
        body: JSON.stringify({ name: "goal", text }),
      }, 90_000)
      assert.ok(response.ok, `/goal ${text} failed: HTTP ${response.status} ${response.text}\n${await diagnostics()}`)

      const deadline = Date.now() + 45_000
      let lastCount = provider.stats.requests.length
      let stableSince = provider.stats.requests.length > before ? Date.now() : 0
      while (Date.now() < deadline) {
        const count = provider.stats.requests.length
        if (count !== lastCount) {
          lastCount = count
          stableSince = count > before ? Date.now() : 0
        }
        if (count > before && stableSince && Date.now() - stableSince >= 750) break
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      assert.ok(
        provider.stats.requests.length > before,
        `/goal ${text} produced no provider request after command admission\n${await diagnostics()}`,
      )
      return provider.stats.requests.slice(before)
    }

    const assertReadOnly = async (text, expected) => {
      const requests = await command(text)
      assert.ok(requests.length >= 1, `read-only /goal ${text} produced no provider request`)
      assert.ok(requests.every((item) => !item.hasControlTool), `read-only /goal ${text} exposed mutating control`)
      assert.ok(requests.some((item) => expected.test(item.currentUserText)), `read-only /goal ${text} did not show expected V1 view\n${JSON.stringify(requests, null, 2)}`)
    }

    const assertMutation = async (text) => {
      const requests = await command(text)
      assert.ok(
        requests.some((item) => item.hasControlTool && item.toolCommand === text),
        `mutating /goal ${text} was not bound to the exact host capability\n${JSON.stringify(requests, null, 2)}`,
      )
      return requests
    }

    await assertMutation('ship control parity --accept "admin surfaces agree" --max-turns 3')
    const initial = await waitFor(async () => {
      const goal = await store.load(sessionID)
      return goal?.objective === "ship control parity" && goal.budget.maxTurns === 3 ? goal : null
    }, "persisted initial V2 Goal", diagnostics)
    assert.equal(initial?.objective, "ship control parity")
    assert.equal(initial?.budget.maxTurns, 3)

    await assertReadOnly("budget", /Budget:/)
    await assertReadOnly("audit", /Goal Audit/)
    await assertReadOnly("doctor", /Goal storage doctor: OK/)
    await assertReadOnly("list", /Project Goal snapshots/)

    await assertMutation("budget --max-turns 9")
    await waitFor(async () => (await store.load(sessionID))?.budget.maxTurns === 9, "persisted V2 budget update", diagnostics)

    await assertMutation('add queued first --accept "first queued done"')
    await waitFor(async () => (await sequences.load(sessionID)).items.length === 1, "first queued Goal persistence", diagnostics)
    await assertMutation('add queued second --check "npm test"')
    let queue = await waitFor(async () => {
      const state = await sequences.load(sessionID)
      return state.items.length === 2 ? state : null
    }, "second queued Goal persistence", diagnostics)
    assert.equal(queue.items.length, 2)
    const firstID = queue.items[0].id
    const secondID = queue.items[1].id

    await assertReadOnly("queue", /Goal Sequence/)
    await assertMutation(`queue move ${secondID.slice(0, 12)} 1`)
    queue = await waitFor(async () => {
      const state = await sequences.load(sessionID)
      return state.items[0]?.id === secondID ? state : null
    }, "queued Goal move persistence", diagnostics)

    await assertMutation(`queue remove ${firstID.slice(0, 12)}`)
    queue = await waitFor(async () => {
      const state = await sequences.load(sessionID)
      return state.items.length === 1 && state.items[0]?.id === secondID ? state : null
    }, "queued Goal removal persistence", diagnostics)

    const archivedID = (await store.load(sessionID)).id
    await assertMutation("clear")
    await waitFor(async () => (await store.load(sessionID)) === null, "cleared current Goal persistence", diagnostics)

    await assertReadOnly("history", /Archived goals/)
    await assertMutation(`restore ${archivedID.slice(0, 12)}`)
    await waitFor(async () => {
      const goal = await store.load(sessionID)
      return goal?.id === archivedID && goal.status === "paused"
    }, "restored archived Goal persistence", diagnostics)

    await assertMutation("clear")
    await waitFor(async () => (await store.load(sessionID)) === null, "cleared restored Goal persistence", diagnostics)
    await assertReadOnly("history", /Archived goals/)
    await assertMutation("history prune --keep 1")
    await waitFor(async () => (await store.history(sessionID, 500)).length === 1, "pruned Goal history persistence", diagnostics)

    await assertMutation("next")
    const promoted = await waitFor(async () => {
      const goal = await store.load(sessionID)
      const state = await sequences.load(sessionID)
      return goal?.id === secondID && goal.status === "active" && state.items.length === 0 ? goal : null
    }, "queued Goal promotion persistence", diagnostics)

    await assertReadOnly("queue", /Pending: 0/)

    assert.equal(server.exitCode, null, `OpenCode 2 server exited during control-plane canary\n${await diagnostics()}`)
    console.log(JSON.stringify({
      ok: true,
      version,
      sessionID,
      readOnlyViews: ["budget", "audit", "doctor", "list", "queue", "history"],
      mutations: ["budget", "add", "queue_move", "queue_remove", "clear", "restore", "history_prune", "next"],
      promotedGoalID: promoted.id,
      exactHostCapabilityBound: true,
      providerRequests: provider.stats.requests,
    }, null, 2))
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
