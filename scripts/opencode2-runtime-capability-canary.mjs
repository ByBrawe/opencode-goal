import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import process from "node:process"

const OPENCODE_BINARY = process.env.OPENCODE2_BINARY || "opencode2"
const SERVER_USERNAME = "opencode"
const SERVER_PASSWORD = "opencode-goal-v2-runtime-capabilities"

function appendLog(current, chunk, limit = 100_000) {
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

async function waitFor(predicate, description, diagnostics, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for ${description}\n${await diagnostics()}`)
}

function streamText(res, sequence, text) {
  const id = `chatcmpl-goal-v2-runtime-${sequence}`
  const created = Math.floor(Date.now() / 1000)
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  const send = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`)
  send({
    id,
    object: "chat.completion.chunk",
    created,
    model: "canary",
    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
  })
  send({
    id,
    object: "chat.completion.chunk",
    created,
    model: "canary",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 32, completion_tokens: 4, total_tokens: 36 },
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
    const isCompaction = raw.includes("You MUST summarize the conversation above")
      || raw.includes("Update the existing checkpoint in the conversation above")
    stats.requests.push({
      sequence,
      isCompaction,
      messageCount: Array.isArray(body?.messages) ? body.messages.length : 0,
      toolCount: Array.isArray(body?.tools)
        ? body.tools.length
        : body?.tools && typeof body.tools === "object"
          ? Object.keys(body.tools).length
          : 0,
    })
    if (isCompaction) {
      streamText(res, sequence, [
        "## Objective",
        "- Preserve the exact-host runtime capability proof.",
        "",
        "## Requirements",
        "- Keep the runtime event and compaction boundaries deterministic.",
        "",
        "## Decisions",
        "- Use the exact OpenCode 2.0.11 event vocabulary.",
        "",
        "## Work State",
        "### Completed",
        "- Primary provider turn completed.",
        "### Active",
        "- Manual compaction capability proof.",
        "### Blocked",
        "- (none)",
        "",
        "## Next Move",
        "1. Continue the runtime capability canary.",
        "",
        "## Relevant Files",
        "- (none)",
        "",
        "## Important Context",
        "- This is deterministic canary output.",
      ].join("\n"))
      return
    }
    streamText(res, sequence, `RUNTIME_CAPABILITY_TURN_${sequence}_OK`)
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

function pluginSource() {
  return `import { appendFile } from "node:fs/promises"

const traceFile = process.env.OPENCODE_GOAL_V2_RUNTIME_TRACE

async function trace(event) {
  await appendFile(traceFile, JSON.stringify({ at: Date.now(), ...event }) + "\\n", "utf8")
}

function eventSessionID(event) {
  return event?.properties?.sessionID ?? event?.data?.sessionID ?? event?.sessionID
}

function eventStatus(event) {
  return event?.properties?.status ?? event?.data?.status ?? event?.status
}

export default {
  id: "bybrawe.opencode-goal.v2.runtime-capability-canary",
  async setup(ctx) {
    await trace({ phase: "setup" })

    const controller = new AbortController()
    const eventTask = (async () => {
      try {
        const events = ctx.event.subscribe({ signal: controller.signal })
        await trace({ phase: "event.subscribe.registered" })
        for await (const event of events) {
          await trace({
            phase: "event",
            type: event?.type,
            sessionID: eventSessionID(event),
            status: eventStatus(event),
          })
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          await trace({ phase: "event.subscribe.error", error: String(error) })
        }
      }
    })()

    const contextRegistration = await ctx.session.hook("context", async (event) => {
      await trace({
        phase: "session.context",
        sessionID: event?.sessionID,
        agent: event?.agent,
        messageCount: Array.isArray(event?.messages) ? event.messages.length : 0,
      })
    })

    const compactionRegistration = await ctx.session.hook("compaction", async (event) => {
      await trace({
        phase: "session.compaction",
        sessionID: event?.sessionID,
        agent: event?.agent,
        messageCount: Array.isArray(event?.messages) ? event.messages.length : 0,
      })
    })
    await trace({ phase: "session.compaction.registered" })

    return async () => {
      controller.abort()
      await eventTask.catch(() => {})
      await compactionRegistration?.dispose?.()
      await contextRegistration?.dispose?.()
    }
  },
}
`
}

async function readTrace(file) {
  try {
    const raw = await readFile(file, "utf8")
    return raw.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  } catch (error) {
    if (error?.code === "ENOENT") return []
    throw error
  }
}

async function main() {
  assert.equal(process.platform, "linux", "the exact OpenCode 2 runtime capability canary is intentionally Ubuntu-only")

  const workspace = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-v2-runtime-"))
  const home = path.join(workspace, ".home")
  const pluginDir = path.join(workspace, ".opencode", "plugins")
  const traceFile = path.join(workspace, "runtime-trace.jsonl")
  const provider = startProvider()
  const providerPort = await provider.listen()

  let server
  let serverLog = ""
  let apiPrefix = null
  let sessionID = ""

  await Promise.all([
    mkdir(pluginDir, { recursive: true }),
    mkdir(path.join(home, ".config"), { recursive: true }),
    mkdir(path.join(home, ".local", "share"), { recursive: true }),
    mkdir(path.join(home, ".local", "state"), { recursive: true }),
    mkdir(path.join(home, ".cache"), { recursive: true }),
  ])

  await writeFile(path.join(pluginDir, "opencode-goal-v2-runtime-probe.js"), pluginSource(), "utf8")
  await writeFile(path.join(workspace, "README.md"), "# OpenCode Goal V2 runtime capability canary\n", "utf8")
  await writeFile(path.join(workspace, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "canary/canary",
    providers: {
      canary: {
        name: "Deterministic OpenCode Goal V2 Runtime Canary",
        package: "@opencode-ai/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${providerPort}/v1` },
        models: {
          canary: {
            name: "Deterministic OpenCode Goal V2 Runtime Canary",
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
    OPENCODE_GOAL_V2_RUNTIME_TRACE: traceFile,
    OPENCODE_SERVER_USERNAME: SERVER_USERNAME,
    OPENCODE_SERVER_PASSWORD: SERVER_PASSWORD,
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    CI: "true",
  }

  const diagnostics = async () => {
    const trace = await readTrace(traceFile)
    return [
      `apiPrefix=${String(apiPrefix)}`,
      `sessionID=${sessionID || "none"}`,
      `provider=${JSON.stringify(provider.stats)}`,
      `trace=${JSON.stringify(trace.slice(-100))}`,
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

    for (const prefix of ["/api", ""]) {
      const response = await request(`${prefix}/command`, { method: "GET" }, 10_000).catch(() => null)
      if (response?.ok) {
        apiPrefix = prefix
        break
      }
    }
    assert.notEqual(apiPrefix, null, `OpenCode 2 API never became ready\n${await diagnostics()}`)

    await waitFor(async () => {
      const trace = await readTrace(traceFile)
      return trace.some((item) => item.phase === "event.subscribe.registered")
        && trace.some((item) => item.phase === "session.compaction.registered")
    }, "runtime event and compaction hook registration", diagnostics, 30_000)

    const created = await request(`${apiPrefix}/session`, {
      method: "POST",
      body: JSON.stringify({ title: "OpenCode Goal V2 runtime capability" }),
    })
    assert.ok(created.ok, `session create failed: HTTP ${created.status} ${created.text}\n${await diagnostics()}`)
    sessionID = String((created.body?.data ?? created.body)?.id ?? "")
    assert.ok(sessionID, `session ID missing: ${created.text}`)

    const prompt = await request(`${apiPrefix}/session/${encodeURIComponent(sessionID)}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "prove exact OpenCode 2 runtime event delivery", delivery: "steer", resume: true }),
    }, 120_000)
    assert.ok(prompt.ok, `runtime prompt failed: HTTP ${prompt.status} ${prompt.text}\n${await diagnostics()}`)

    await waitFor(() => provider.stats.requests.length >= 1, "provider request", diagnostics, 60_000)
    await waitFor(async () => {
      const trace = await readTrace(traceFile)
      return trace.some((item) =>
        item.phase === "event"
        && item.sessionID === sessionID
        && (
          item.type === "session.execution.succeeded"
          || item.type === "session.idle"
          || (item.type === "session.status" && item.status?.type === "idle")
          || (item.type === "session.status" && item.status === "idle")
        )
      )
    }, "terminal session execution event through ctx.event.subscribe()", diagnostics, 60_000)

    const compact = await request(`${apiPrefix}/session/${encodeURIComponent(sessionID)}/compact`, {
      method: "POST",
      body: JSON.stringify({}),
    }, 30_000)
    assert.ok(compact.ok, `manual compaction admission failed: HTTP ${compact.status} ${compact.text}\n${await diagnostics()}`)

    await waitFor(async () => {
      const trace = await readTrace(traceFile)
      return trace.some((item) => item.phase === "session.compaction" && item.sessionID === sessionID)
    }, "session.compaction hook on a real manual compaction", diagnostics, 60_000)

    await waitFor(async () => {
      const trace = await readTrace(traceFile)
      return trace.some((item) =>
        item.phase === "event"
        && item.sessionID === sessionID
        && (
          item.type === "session.compaction.ended"
          || item.type === "session.compacted"
        )
      )
    }, "terminal compaction event through ctx.event.subscribe()", diagnostics, 60_000)

    const trace = await readTrace(traceFile)
    assert.ok(
      trace.some((item) => item.phase === "session.context" && item.sessionID === sessionID),
      `session.context did not fire for the primary provider turn\n${await diagnostics()}`,
    )
    assert.ok(
      !trace.some((item) => item.phase === "event.subscribe.error"),
      `ctx.event.subscribe() reported an error\n${await diagnostics()}`,
    )

    const sessionEvents = trace.filter((item) => item.phase === "event" && item.sessionID === sessionID)
    console.log(JSON.stringify({
      ok: true,
      version,
      apiPrefix,
      sessionID,
      providerRequests: provider.stats.requests.length,
      compactionHookRegistered: true,
      compactionHookObserved: trace.some((item) => item.phase === "session.compaction" && item.sessionID === sessionID),
      compactionEndedObserved: sessionEvents.some((item) => item.type === "session.compaction.ended"),
      compactionFailedObserved: sessionEvents.some((item) => item.type === "session.compaction.failed"),
      compactionTerminalType: sessionEvents.find((item) =>
        item.type === "session.compaction.ended"
        || item.type === "session.compacted"
      )?.type,
      legacyCompactedEventObserved: sessionEvents.some((item) => item.type === "session.compacted"),
      contextHookObserved: true,
      eventTypes: [...new Set(sessionEvents.map((item) => item.type).filter(Boolean))],
      terminalEventObserved: sessionEvents.some((item) =>
        item.type === "session.execution.succeeded"
        || item.type === "session.idle"
        || (item.type === "session.status" && (item.status?.type === "idle" || item.status === "idle"))
      ),
      executionSucceededObserved: sessionEvents.some((item) => item.type === "session.execution.succeeded"),
    }, null, 2))
  } finally {
    await stopProcess(server)
    await provider.close().catch(() => {})
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
