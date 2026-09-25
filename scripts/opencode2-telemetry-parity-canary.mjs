import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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
const PASSWORD = "opencode-goal-v2-telemetry-parity"
const DIRECT_ENV = "OPENCODE_GOAL_V2_DIRECT_LIFECYCLE"
const AUTONOMOUS_ENV = "OPENCODE_GOAL_V2_AUTONOMOUS"
const CONTROL_TOOL = "opencode_goals_v2_control"
const WRITE_TOOL = "write"
const PROGRESS_FILE = "telemetry-progress.txt"
const CREATE_COMMAND = 'prove V2 telemetry parity --constraint "use host-observed progress only"'

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
    if (child.exitCode !== null) throw new Error(`OpenCode 2 exited before ready.\n${logs()}`)
    const ok = await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port })
      socket.once("connect", () => { socket.destroy(); resolve(true) })
      socket.once("error", () => resolve(false))
      socket.setTimeout(500, () => { socket.destroy(); resolve(false) })
    })
    if (ok) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for OpenCode 2 on ${port}\n${logs()}`)
}

async function stop(child) {
  if (!child || child.exitCode !== null) return
  child.kill("SIGTERM")
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 5_000)
    child.once("close", () => { clearTimeout(timer); resolve() })
  })
}

async function waitFor(predicate, description, diagnostics, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 75))
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

function toolDefinition(body, name) {
  if (Array.isArray(body?.tools)) {
    return body.tools.find((item) => (item?.function?.name ?? item?.name) === name)
  }
  return body?.tools?.[name]
}

function writeArgs(body, absolutePath) {
  const definition = toolDefinition(body, WRITE_TOOL)
  if (!definition) throw new Error("exact OpenCode 2 request did not expose the write tool definition")
  const parameters = definition.function?.parameters ?? definition.input ?? definition.inputSchema ?? {}
  const properties = parameters?.properties ?? {}
  if (Object.prototype.hasOwnProperty.call(properties, "path")) {
    return { path: absolutePath, content: "host-observed-v2-progress\n" }
  }
  if (Object.prototype.hasOwnProperty.call(properties, "filePath")) {
    return { filePath: absolutePath, content: "host-observed-v2-progress\n" }
  }
  if (Object.prototype.hasOwnProperty.call(properties, "file_path")) {
    return { file_path: absolutePath, content: "host-observed-v2-progress\n" }
  }
  throw new Error(`unsupported exact OpenCode 2 write schema: ${JSON.stringify(parameters)}`)
}

function headers(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
}

function sse(res, value) {
  res.write(`data: ${JSON.stringify(value)}\n\n`)
}

function streamStop(res, sequence, text) {
  const id = `chatcmpl-v2-telemetry-parity-${sequence}`
  const created = Math.floor(Date.now() / 1000)
  headers(res)
  sse(res, {
    id, object: "chat.completion.chunk", created, model: "canary",
    choices: [{ index: 0, delta: text === undefined ? { role: "assistant" } : { role: "assistant", content: text }, finish_reason: null }],
  })
  sse(res, {
    id, object: "chat.completion.chunk", created, model: "canary",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 31, completion_tokens: text ? 6 : 0, total_tokens: text ? 37 : 31 },
  })
  res.end("data: [DONE]\n\n")
}

function streamTool(res, sequence, name, args, prefix) {
  const id = `chatcmpl-v2-telemetry-${prefix}-${sequence}`
  const created = Math.floor(Date.now() / 1000)
  headers(res)
  sse(res, {
    id, object: "chat.completion.chunk", created, model: "canary",
    choices: [{
      index: 0,
      delta: {
        role: "assistant",
        tool_calls: [{
          index: 0,
          id: `call-v2-telemetry-${prefix}-${sequence}`,
          type: "function",
          function: { name, arguments: "" },
        }],
      },
      finish_reason: null,
    }],
  })
  sse(res, {
    id, object: "chat.completion.chunk", created, model: "canary",
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] },
      finish_reason: null,
    }],
  })
  sse(res, {
    id, object: "chat.completion.chunk", created, model: "canary",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 33, completion_tokens: 8, total_tokens: 41 },
  })
  res.end("data: [DONE]\n\n")
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function provider(progressFilePath) {
  const stats = { requests: [] }
  const firstFinalGate = deferred()
  const secondEmptyGate = deferred()
  const thirdEmptyGate = deferred()
  let autonomousStep = 0
  let firstFinalHeld = false
  let secondEmptyHeld = false
  let thirdEmptyHeld = false

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
    const sawControlResult = /single-use capability is consumed/i.test(current.turnText)
    const autonomous = current.userText.includes("Continue working toward the active OpenCode goal.")

    stats.requests.push({
      sequence,
      userText: current.userText,
      tools,
      hasControl,
      sawControlResult,
      autonomous,
      autonomousStep,
    })

    if (hasControl && current.userText.includes(CREATE_COMMAND) && !sawControlResult) {
      streamTool(res, sequence, CONTROL_TOOL, { command: CREATE_COMMAND }, "control")
      return
    }

    if (!autonomous) {
      streamStop(res, sequence, `LIFECYCLE_SETTLED_${sequence}`)
      return
    }

    if (autonomousStep === 0) {
      autonomousStep = 1
      assert.ok(tools.includes(WRITE_TOOL), `built-in write tool missing from first Goal execution: ${JSON.stringify(tools)}`)
      streamTool(res, sequence, WRITE_TOOL, writeArgs(body, progressFilePath), "write")
      return
    }

    if (autonomousStep === 1) {
      firstFinalHeld = true
      await firstFinalGate.promise
      autonomousStep = 2
      streamStop(res, sequence, undefined)
      return
    }

    if (autonomousStep === 2) {
      secondEmptyHeld = true
      await secondEmptyGate.promise
      autonomousStep = 3
      streamStop(res, sequence, undefined)
      return
    }

    if (autonomousStep === 3) {
      thirdEmptyHeld = true
      await thirdEmptyGate.promise
      autonomousStep = 4
      streamStop(res, sequence, undefined)
      return
    }

    streamStop(res, sequence, "UNEXPECTED_FOURTH_GOAL_EXECUTION")
  })

  return {
    stats,
    get firstFinalHeld() { return firstFinalHeld },
    get secondEmptyHeld() { return secondEmptyHeld },
    get thirdEmptyHeld() { return thirdEmptyHeld },
    releaseFirstFinal() { firstFinalGate.resolve?.() },
    releaseSecondEmpty() { secondEmptyGate.resolve?.() },
    releaseThirdEmpty() { thirdEmptyGate.resolve?.() },
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
      firstFinalGate.resolve?.()
      secondEmptyGate.resolve?.()
      thirdEmptyGate.resolve?.()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

function commandNames(payload) {
  const data = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : []
  return new Set(data.map((item) => item?.name ?? item?.id).filter((name) => typeof name === "string"))
}

async function main() {
  assert.equal(process.platform, "linux", "the exact V2 telemetry parity canary is intentionally Ubuntu-only")

  const workspace = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-v2-telemetry-parity-"))
  const home = path.join(workspace, ".home")
  const pluginDir = path.join(workspace, ".opencode", "plugins")
  const bridge = path.join(pluginDir, "opencode-goal-server.js")
  const progressFilePath = path.join(workspace, PROGRESS_FILE)
  const p = provider(progressFilePath)
  const providerPort = await p.listen()

  let server
  let serverLog = ""
  let sessionID = ""
  let commands = new Set()
  const store = new GoalStore(workspace)

  await Promise.all([
    mkdir(pluginDir, { recursive: true }),
    mkdir(path.join(home, ".config"), { recursive: true }),
    mkdir(path.join(home, ".local", "share"), { recursive: true }),
    mkdir(path.join(home, ".local", "state"), { recursive: true }),
    mkdir(path.join(home, ".cache"), { recursive: true }),
  ])

  await writeFile(bridge, `export { default } from ${JSON.stringify(pathToFileURL(serverFile).href)}\n`, "utf8")
  await writeFile(path.join(workspace, "README.md"), "# V2 telemetry parity canary\n", "utf8")
  await writeFile(path.join(workspace, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "canary/canary",
    small_model: "canary/canary",
    providers: {
      canary: {
        name: "Deterministic V2 Telemetry Parity",
        package: "@opencode-ai/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${providerPort}/v1` },
        models: {
          canary: {
            name: "Deterministic V2 Telemetry Parity",
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
    OPENCODE_SERVER_USERNAME: USERNAME,
    OPENCODE_SERVER_PASSWORD: PASSWORD,
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    CI: "true",
  }

  const diagnostics = async () => [
    `sessionID=${sessionID || "none"}`,
    `goal=${JSON.stringify(sessionID ? await store.load(sessionID).catch((error) => ({ error: String(error) })) : null)}`,
    `provider=${JSON.stringify(p.stats)}`,
    `serverExit=${server?.exitCode}`,
    `serverLog=${serverLog}`,
  ].join("\n")

  try {
    const version = String(execFileSync(OPENCODE_BINARY, ["--version"], { cwd: workspace, env, encoding: "utf8" })).trim()
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
      let body = null
      if (text) {
        try { body = JSON.parse(text) } catch { body = text }
      }
      return { ok: response.ok, status: response.status, body, text }
    }

    await waitFor(async () => {
      const response = await request("/api/command", { method: "GET" }, 5_000).catch(() => null)
      if (!response?.ok) return false
      commands = commandNames(response.body)
      return commands.has("goal")
    }, "Goal command registration", diagnostics, 30_000)

    const created = await request("/api/session", {
      method: "POST",
      body: JSON.stringify({ title: "V2 telemetry parity" }),
    })
    assert.ok(created.ok, `session create failed: ${created.status} ${created.text}`)
    sessionID = String((created.body?.data ?? created.body)?.id ?? "")
    assert.ok(sessionID)

    const commandPromise = request(`/api/session/${encodeURIComponent(sessionID)}/command`, {
      method: "POST",
      body: JSON.stringify({ name: "goal", text: CREATE_COMMAND }),
    })

    await waitFor(() => p.firstFinalHeld, "first Goal tool loop follow-up", diagnostics)

    await waitFor(async () => {
      try {
        return await readFile(progressFilePath, "utf8") === "host-observed-v2-progress\n"
      } catch (error) {
        if (error?.code === "ENOENT") return false
        throw error
      }
    }, "built-in write tool durable progress proof", diagnostics)
    const duringToolLoop = await waitFor(async () => {
      const goal = await store.load(sessionID)
      return goal?.progressRevision === 1 ? goal : null
    }, "host-observed V2 tool progress", diagnostics)
    assert.equal(duringToolLoop.usage.turns, 0, "usage turn is settled only at execution terminal")
    assert.equal(duringToolLoop.status, "active")

    p.releaseFirstFinal()
    await waitFor(() => p.secondEmptyHeld, "second Goal execution admission", diagnostics)

    const afterMeaningful = await waitFor(async () => {
      const goal = await store.load(sessionID)
      return goal?.usage.turns === 1 && goal.progressRevision === 1 ? goal : null
    }, "one logical V2 Goal turn after multi-step tool loop", diagnostics)
    assert.equal(afterMeaningful.status, "active")
    assert.equal(afterMeaningful.emptyTurnCount ?? 0, 0, "tool-only work with blank final text is still meaningful")
    assert.equal(afterMeaningful.stalledTurns, 0)
    assert.ok(afterMeaningful.usage.tokens > 0)
    assert.ok((afterMeaningful.execution?.modelContext?.lastRequestTokens ?? 0) > 0)
    assert.deepEqual(
      afterMeaningful.execution?.model,
      { providerID: "canary", modelID: "canary" },
      "exact host registry identity must be persisted for the Goal-owned execution",
    )
    assert.equal(
      afterMeaningful.execution?.modelContext?.contextLimit,
      100000,
      "exact host model registry context limit must be persisted",
    )
    assert.equal(
      afterMeaningful.execution?.modelContext?.outputLimit,
      4096,
      "exact host model registry output limit must be persisted",
    )

    const tokensAfterMeaningful = afterMeaningful.usage.tokens
    p.releaseSecondEmpty()
    await waitFor(() => p.thirdEmptyHeld, "third Goal execution admission", diagnostics)

    const afterFirstEmpty = await waitFor(async () => {
      const goal = await store.load(sessionID)
      return goal?.emptyTurnCount === 1 ? goal : null
    }, "first empty V2 Goal retry state", diagnostics)
    assert.equal(afterFirstEmpty.status, "active")
    assert.equal(afterFirstEmpty.usage.turns, 1, "first empty attempt must not consume logical turn budget")
    assert.ok(afterFirstEmpty.usage.tokens > tokensAfterMeaningful, "empty attempt must preserve billable tokens")
    assert.equal(afterFirstEmpty.stalledTurns, 0, "empty retry owns policy instead of generic stall counter")

    p.releaseThirdEmpty()
    const paused = await waitFor(async () => {
      const goal = await store.load(sessionID)
      return goal?.status === "paused" && goal.emptyTurnCount === 2 ? goal : null
    }, "second consecutive empty V2 Goal pause", diagnostics)

    assert.equal(paused.usage.turns, 1)
    assert.ok(paused.usage.tokens > afterFirstEmpty.usage.tokens)
    assert.match(paused.stopReason ?? "", /2 consecutive Goal-owned assistant turns completed without meaningful/)
    assert.equal(paused.progressRevision, 1)

    const commandResult = await commandPromise
    assert.ok(commandResult.ok, `direct Goal command failed: ${commandResult.status} ${commandResult.text}\n${await diagnostics()}`)

    await new Promise((resolve) => setTimeout(resolve, 750))
    const autonomousProviderRequests = p.stats.requests.filter((item) => item.autonomous)
    assert.equal(autonomousProviderRequests.length, 4, "one tool loop plus two empty executions should use exactly four provider calls")
    assert.equal(
      autonomousProviderRequests.some((item) => item.userText.includes("UNEXPECTED_FOURTH_GOAL_EXECUTION")),
      false,
    )
    assert.equal(server.exitCode, null, `OpenCode 2 server exited during telemetry parity canary\n${await diagnostics()}`)

    console.log(JSON.stringify({
      ok: true,
      version,
      sessionID,
      finalStatus: paused.status,
      progressRevision: paused.progressRevision,
      logicalTurns: paused.usage.turns,
      tokens: paused.usage.tokens,
      emptyTurnCount: paused.emptyTurnCount,
      stalledTurns: paused.stalledTurns,
      model: paused.execution?.model,
      contextLimit: paused.execution?.modelContext?.contextLimit,
      outputLimit: paused.execution?.modelContext?.outputLimit,
      lastRequestTokens: paused.execution?.modelContext?.lastRequestTokens,
      autonomousProviderCalls: autonomousProviderRequests.length,
      providerRequests: p.stats.requests,
    }, null, 2))
  } finally {
    p.releaseFirstFinal()
    p.releaseSecondEmpty()
    p.releaseThirdEmpty()
    await stop(server)
    await p.close().catch(() => undefined)
    await rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }).catch(() => undefined)
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
