import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { pathToFileURL } from "node:url"

const OPENCODE_BINARY = process.env.OPENCODE2_BINARY || "opencode2"
const USERNAME = "opencode"
const PASSWORD = "opencode-goal-v2-host-limit-proof"

function append(current, chunk, limit = 120_000) {
  return (current + String(chunk)).slice(-limit)
}

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") return reject(new Error("failed to reserve port"))
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

async function waitForTcp(port, child, logs, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`OpenCode exited before ready.\n${logs()}`)
    const ok = await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port })
      socket.once("connect", () => { socket.destroy(); resolve(true) })
      socket.once("error", () => resolve(false))
      socket.setTimeout(500, () => { socket.destroy(); resolve(false) })
    })
    if (ok) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`OpenCode readiness timeout\n${logs()}`)
}

async function stop(child) {
  if (!child || child.exitCode !== null) return
  child.kill("SIGTERM")
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 5_000)
    child.once("close", () => { clearTimeout(timer); resolve() })
  })
}

async function waitFor(predicate, label, diagnostics, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 75))
  }
  throw new Error(`timed out waiting for ${label}\n${await diagnostics()}`)
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

function pluginSource() {
  return `import { appendFile } from "node:fs/promises"

const traceFile = process.env.OPENCODE_GOAL_V2_HOST_LIMIT_TRACE

async function trace(value) {
  await appendFile(traceFile, JSON.stringify({ at: Date.now(), ...value }) + "\\n", "utf8")
}

function safe(value) {
  try { return JSON.parse(JSON.stringify(value)) } catch { return String(value) }
}

export default {
  id: "bybrawe.opencode-goal.v2.host-limit-capability",
  async setup(ctx) {
    const controller = new AbortController()
    const task = (async () => {
      const events = ctx.event.subscribe({ signal: controller.signal })
      await trace({ phase: "event.subscribe.registered" })
      for await (const event of events) {
        if (event?.type !== "session.error" && event?.type !== "session.status" && !String(event?.type ?? "").startsWith("session.execution.")) continue
        await trace({
          phase: "event",
          type: event?.type,
          properties: safe(event?.properties),
          data: safe(event?.data),
        })
      }
    })()

    return async () => {
      controller.abort()
      await task.catch(() => undefined)
    }
  },
}
`
}

function contentText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((part) => typeof part === "string" ? part : (part?.text ?? part?.content ?? "")).join("\n")
}

function latestUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (String(messages[i]?.role ?? "").toLowerCase() === "user") return contentText(messages[i]?.content)
  }
  return ""
}

function streamSuccess(res) {
  const id = "chatcmpl-host-limit-retry-success"
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
    choices: [{ index: 0, delta: { role: "assistant", content: "RETRY_RECOVERED" }, finish_reason: null }],
  })
  send({
    id,
    object: "chat.completion.chunk",
    created,
    model: "canary",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 },
  })
  res.end("data: [DONE]\n\n")
}

function startProvider() {
  const stats = { overflow: 0, retry: 0 }
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
    const text = latestUserText(body)

    if (text.includes("OVERFLOW_PROBE")) {
      stats.overflow += 1
      res.writeHead(400, { "content-type": "application/json" })
      res.end(JSON.stringify({
        error: {
          message: "Prompt exceeds max length for exact host-limit proof",
          type: "invalid_request_error",
          code: "context_length_exceeded",
        },
      }))
      return
    }

    if (text.includes("RETRY_PROBE")) {
      stats.retry += 1
      if (stats.retry === 1) {
        res.writeHead(429, {
          "content-type": "application/json",
          "retry-after": "0",
        })
        res.end(JSON.stringify({
          error: {
            message: "temporary rate limit for exact host-limit proof",
            type: "rate_limit_error",
            code: "rate_limit_exceeded",
          },
        }))
        return
      }
      streamSuccess(res)
      return
    }

    streamSuccess(res)
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
    async close() { await new Promise((resolve) => server.close(resolve)) },
  }
}

async function main() {
  assert.equal(process.platform, "linux", "host-limit capability proof is intentionally Ubuntu-only")
  const workspace = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-v2-host-limit-"))
  const home = path.join(workspace, ".home")
  const pluginDir = path.join(workspace, ".opencode", "plugins")
  const traceFile = path.join(workspace, "host-limit-trace.jsonl")
  const p = startProvider()
  const providerPort = await p.listen()
  let child
  let log = ""

  try {
    await Promise.all([
      mkdir(pluginDir, { recursive: true }),
      mkdir(path.join(home, ".config"), { recursive: true }),
      mkdir(path.join(home, ".local", "share"), { recursive: true }),
      mkdir(path.join(home, ".local", "state"), { recursive: true }),
      mkdir(path.join(home, ".cache"), { recursive: true }),
    ])
    const pluginPath = path.join(pluginDir, "host-limit-capability.js")
    await writeFile(pluginPath, pluginSource(), "utf8")
    await writeFile(path.join(workspace, "opencode.json"), JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: "canary/canary",
      providers: {
        canary: {
          name: "Host Limit Capability Provider",
          package: "@opencode-ai/ai/providers/openai-compatible",
          settings: { baseURL: `http://127.0.0.1:${providerPort}/v1` },
          models: {
            canary: {
              name: "Host Limit Capability Provider",
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              limit: { context: 100000, output: 4096 },
            },
          },
        },
      },
    }, null, 2) + "\n", "utf8")
    await writeFile(path.join(workspace, "README.md"), "# Host limit capability proof\n", "utf8")

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
      OPENCODE_GOAL_V2_HOST_LIMIT_TRACE: traceFile,
      OPENCODE_SERVER_USERNAME: USERNAME,
      OPENCODE_SERVER_PASSWORD: PASSWORD,
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
      CI: "true",
    }

    const version = String(execFileSync(OPENCODE_BINARY, ["--version"], { cwd: workspace, env, encoding: "utf8" })).trim()
    assert.ok(version.includes("2.0.11"), `expected exact 2.0.11, got ${version}`)

    const port = await reservePort()
    child = spawn(OPENCODE_BINARY, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: workspace, env, windowsHide: true,
    })
    child.stdout?.on("data", (chunk) => { log = append(log, chunk) })
    child.stderr?.on("data", (chunk) => { log = append(log, chunk) })
    await waitForTcp(port, child, () => log)

    const baseURL = `http://127.0.0.1:${port}`
    const authorization = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64")}`
    const request = async (pathname, init = {}, timeoutMs = 45_000) => {
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

    const diagnostics = async () => [
      `provider=${JSON.stringify(p.stats)}`,
      `trace=${JSON.stringify((await readTrace(traceFile)).slice(-80))}`,
      `serverExit=${child?.exitCode}`,
      `serverLog=${log}`,
    ].join("\n")

    await waitFor(async () => {
      const ready = await request("/api/command", { method: "GET" }, 5_000).catch(() => null)
      const trace = await readTrace(traceFile)
      return ready?.ok && trace.some((item) => item.phase === "event.subscribe.registered")
    }, "host-limit event probe registration", diagnostics, 30_000)

    const createSession = async (title) => {
      const response = await request("/api/session", {
        method: "POST",
        body: JSON.stringify({ title }),
      })
      assert.ok(response.ok, `session create failed: ${response.status} ${response.text}`)
      return String((response.body?.data ?? response.body)?.id ?? "")
    }

    const sendPrompt = async (sessionID, text) => await request(`/api/session/${encodeURIComponent(sessionID)}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text, delivery: "steer", resume: true }),
    }, 60_000)

    const overflowSession = await createSession("V2 host limit overflow")
    const overflow = await sendPrompt(overflowSession, "OVERFLOW_PROBE")
    assert.ok(overflow.ok || overflow.status >= 400, `unexpected overflow response ${overflow.status}`)

    const errorEvent = await waitFor(async () => {
      const trace = await readTrace(traceFile)
      return trace.find((item) =>
        item.phase === "event"
        && item.type === "session.execution.failed"
        && item.data?.sessionID === overflowSession
      )
    }, "exact session.execution.failed overflow event", diagnostics)
    assert.equal(errorEvent.data.sessionID, overflowSession)
    assert.ok(errorEvent.data.error && typeof errorEvent.data.error === "object")
    assert.equal(errorEvent.data.error.type, "provider.invalid-request")
    assert.equal(errorEvent.data.error.status, 400)
    assert.match(String(errorEvent.data.error.message ?? ""), /prompt exceeds max length/i)

    const retrySession = await createSession("V2 host limit retry")
    const retryPromise = sendPrompt(retrySession, "RETRY_PROBE")
    const retryStatus = await waitFor(async () => {
      const trace = await readTrace(traceFile)
      return trace.find((item) =>
        item.phase === "event"
        && item.type === "session.status"
        && item.properties?.sessionID === retrySession
        && item.properties?.status?.type === "retry"
      )
    }, "exact session.status retry event", diagnostics, 60_000)
    assert.equal(typeof retryStatus.properties.status.attempt, "number")
    assert.equal(typeof retryStatus.properties.status.message, "string")
    const retryResult = await retryPromise
    assert.ok(retryResult.ok, `retry session did not recover: ${retryResult.status} ${retryResult.text}`)

    console.log(JSON.stringify({
      ok: true,
      version,
      overflow: {
        event: errorEvent,
        providerRequests: p.stats.overflow,
      },
      retry: {
        event: retryStatus,
        providerRequests: p.stats.retry,
      },
    }, null, 2))
  } finally {
    await stop(child)
    await p.close().catch(() => undefined)
    await rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }).catch(() => undefined)
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
