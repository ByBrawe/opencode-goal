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
const PASSWORD = "opencode-goal-v2-telemetry"
const TOOL = "opencode_goal_v2_telemetry_probe"
const TEXT_PROBE = "GOAL_V2_TEXT_TELEMETRY_PROBE"
const TOOL_PROBE = "GOAL_V2_TOOL_TELEMETRY_PROBE"
const EMPTY_PROBE = "GOAL_V2_EMPTY_TELEMETRY_PROBE"

function append(current, chunk, limit = 160_000) {
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

async function waitFor(predicate, description, diagnostics, timeoutMs = 60_000) {
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
  return content.map((part) => typeof part === "string" ? part : (part?.text ?? part?.content ?? "")).join("\n")
}

function latestUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (String(messages[i]?.role ?? "").toLowerCase() === "user") return contentText(messages[i]?.content)
  }
  return ""
}

function toolNames(body) {
  if (Array.isArray(body?.tools)) return body.tools.map((item) => item?.function?.name ?? item?.name).filter(Boolean)
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

function sse(res, value) {
  res.write(`data: ${JSON.stringify(value)}\n\n`)
}

function streamStop(res, sequence, text) {
  const id = `chatcmpl-v2-telemetry-${sequence}`
  const created = Math.floor(Date.now() / 1000)
  headers(res)
  if (text !== undefined) {
    sse(res, {
      id, object: "chat.completion.chunk", created, model: "canary",
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    })
  } else {
    sse(res, {
      id, object: "chat.completion.chunk", created, model: "canary",
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    })
  }
  sse(res, {
    id, object: "chat.completion.chunk", created, model: "canary",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 31, completion_tokens: text ? 7 : 0, total_tokens: text ? 38 : 31 },
  })
  res.end("data: [DONE]\n\n")
}

function streamTool(res, sequence) {
  const id = `chatcmpl-v2-telemetry-tool-${sequence}`
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
          id: `call-v2-telemetry-${sequence}`,
          type: "function",
          function: { name: TOOL, arguments: "" },
        }],
      },
      finish_reason: null,
    }],
  })
  sse(res, {
    id, object: "chat.completion.chunk", created, model: "canary",
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ value: "mutation-proof" }) } }] },
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

function provider() {
  const stats = { requests: [] }
  let toolIssued = false
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
    const userText = latestUserText(body)
    const tools = toolNames(body)
    const toolResultSeen = JSON.stringify(body?.messages ?? []).includes("TELEMETRY_TOOL_OK")
    stats.requests.push({ sequence, userText, tools, toolResultSeen })

    if (userText.includes(TOOL_PROBE) && tools.includes(TOOL) && !toolIssued) {
      toolIssued = true
      streamTool(res, sequence)
      return
    }
    if (userText.includes(TOOL_PROBE)) {
      streamStop(res, sequence, undefined)
      return
    }
    if (userText.includes(EMPTY_PROBE)) {
      streamStop(res, sequence, undefined)
      return
    }
    streamStop(res, sequence, TEXT_PROBE)
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
    async close() { await new Promise((resolve) => server.close(resolve)) },
  }
}

function pluginSource() {
  return `import { appendFile, writeFile } from "node:fs/promises"
import path from "node:path"

const traceFile = process.env.OPENCODE_GOAL_V2_TELEMETRY_TRACE
const TOOL = ${JSON.stringify(TOOL)}

async function trace(item) {
  if (!traceFile) return
  await appendFile(traceFile, JSON.stringify({ at: Date.now(), ...item }) + "\\n", "utf8")
}

function compactEvent(event) {
  const data = event?.data
  const properties = event?.properties
  return {
    phase: "event",
    type: event?.type,
    id: event?.id,
    created: event?.created,
    metadata: event?.metadata,
    data,
    properties,
  }
}

export default {
  id: "bybrawe.opencode-goal.v2.telemetry-capability",
  async setup(ctx) {
    await trace({
      phase: "setup",
      eventSubscribe: typeof ctx.event?.subscribe === "function",
      toolTransform: typeof ctx.tool?.transform === "function",
      contextHook: typeof ctx.session?.hook === "function",
    })

    await ctx.tool.transform((tools) => {
      tools.add({
        name: TOOL,
        description: "Telemetry capability probe tool.",
        input: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        output: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
          additionalProperties: false,
        },
        options: { codemode: false },
        codemode: false,
        execute: async (input, toolContext) => {
          const root = ctx.options?.directory ?? process.cwd()
          await writeFile(path.join(root, "telemetry-progress.txt"), String(input?.value ?? ""), "utf8")
          await trace({ phase: "tool.execute", sessionID: toolContext?.sessionID, callID: toolContext?.callID, input })
          return { output: { message: "TELEMETRY_TOOL_OK" }, content: "TELEMETRY_TOOL_OK" }
        },
      })
    })

    await ctx.session.hook("context", async (event) => {
      await trace({
        phase: "context",
        sessionID: event?.sessionID,
        messageID: event?.messageID,
        agent: event?.agent,
        model: event?.model,
        options: event?.options,
        keys: event && typeof event === "object" ? Object.keys(event).sort() : [],
      })
    })

    const controller = new AbortController()
    const task = (async () => {
      const events = ctx.event.subscribe({ signal: controller.signal })
      await trace({ phase: "event.subscribe.registered" })
      for await (const event of events) await trace(compactEvent(event))
    })()

    return async () => {
      controller.abort()
      await task.catch(() => undefined)
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

function eventSessionID(item) {
  return item?.data?.sessionID ?? item?.properties?.sessionID ?? item?.properties?.info?.sessionID
}

async function main() {
  assert.equal(process.platform, "linux", "telemetry capability proof is intentionally Ubuntu-only")
  const workspace = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-v2-telemetry-"))
  const home = path.join(workspace, ".home")
  const pluginDir = path.join(workspace, ".opencode", "plugins")
  const traceFile = path.join(workspace, "telemetry-trace.jsonl")
  const p = provider()
  const providerPort = await p.listen()
  let server
  let serverLog = ""
  let sessionID = ""

  try {
    await Promise.all([
      mkdir(pluginDir, { recursive: true }),
      mkdir(path.join(home, ".config"), { recursive: true }),
      mkdir(path.join(home, ".local", "share"), { recursive: true }),
      mkdir(path.join(home, ".local", "state"), { recursive: true }),
      mkdir(path.join(home, ".cache"), { recursive: true }),
    ])
    await writeFile(path.join(pluginDir, "telemetry-capability.js"), pluginSource(), "utf8")
    await writeFile(path.join(workspace, "README.md"), "# V2 telemetry capability\n", "utf8")
    await writeFile(path.join(workspace, "opencode.json"), JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: "canary/canary",
      providers: {
        canary: {
          name: "Telemetry Capability Provider",
          package: "@opencode-ai/ai/providers/openai-compatible",
          settings: { baseURL: `http://127.0.0.1:${providerPort}/v1` },
          models: {
            canary: {
              name: "Telemetry Capability Provider",
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              limit: { context: 100000, input: 90000, output: 4096 },
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
      OPENCODE_GOAL_V2_TELEMETRY_TRACE: traceFile,
      OPENCODE_SERVER_USERNAME: USERNAME,
      OPENCODE_SERVER_PASSWORD: PASSWORD,
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
      CI: "true",
    }

    const version = String(execFileSync(OPENCODE_BINARY, ["--version"], { cwd: workspace, env, encoding: "utf8" })).trim()
    assert.ok(version.includes("2.0.11"), `expected exact OpenCode 2.0.11, got ${version}`)

    const port = await reservePort()
    server = spawn(OPENCODE_BINARY, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: workspace, env, windowsHide: true,
    })
    server.stdout?.on("data", (chunk) => { serverLog = append(serverLog, chunk) })
    server.stderr?.on("data", (chunk) => { serverLog = append(serverLog, chunk) })
    await waitForTcp(port, server, () => serverLog)

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
      let body
      try { body = text ? JSON.parse(text) : null } catch { body = text }
      return { ok: response.ok, status: response.status, body, text }
    }

    const diagnostics = async () => [
      `sessionID=${sessionID || "none"}`,
      `provider=${JSON.stringify(p.stats)}`,
      `trace=${JSON.stringify((await readTrace(traceFile)).slice(-120))}`,
      `serverExit=${server?.exitCode}`,
      `serverLog=${serverLog}`,
    ].join("\n")

    await waitFor(async () => {
      const ready = await request("/api/command", { method: "GET" }, 5_000).catch(() => null)
      const trace = await readTrace(traceFile)
      return ready?.ok && trace.some((item) => item.phase === "event.subscribe.registered")
    }, "telemetry probe registration", diagnostics, 30_000)

    const created = await request("/api/session", {
      method: "POST",
      body: JSON.stringify({ title: "V2 telemetry capability" }),
    })
    assert.ok(created.ok, `session create failed: ${created.status} ${created.text}`)
    sessionID = String((created.body?.data ?? created.body)?.id ?? "")
    assert.ok(sessionID)

    const prompt = async (text) => {
      const response = await request(`/api/session/${encodeURIComponent(sessionID)}/prompt`, {
        method: "POST",
        body: JSON.stringify({ text, delivery: "steer", resume: true }),
      }, 120_000)
      assert.ok(response.ok, `prompt failed: ${response.status} ${response.text}\n${await diagnostics()}`)
    }

    const waitForExecutionCount = async (count, description) => await waitFor(async () => {
      const items = await readTrace(traceFile)
      const terminals = items.filter((item) => item.type === "session.execution.succeeded" && eventSessionID(item) === sessionID)
      return terminals.length >= count ? items : null
    }, description, diagnostics, 120_000)

    await prompt(TEXT_PROBE)
    await waitForExecutionCount(1, "text telemetry execution terminal")

    await prompt(TOOL_PROBE)
    await waitForExecutionCount(2, "tool telemetry execution terminal")

    await prompt(EMPTY_PROBE)
    const trace = await waitForExecutionCount(3, "empty telemetry execution terminal")

    const events = trace.filter((item) => item.phase === "event" && eventSessionID(item) === sessionID)
    const types = new Set(events.map((item) => item.type))
    const executions = []
    let currentExecution = null
    for (const event of events) {
      if (event.type === "session.execution.started") currentExecution = []
      if (currentExecution) currentExecution.push(event)
      if (currentExecution && event.type === "session.execution.succeeded") {
        executions.push(currentExecution)
        currentExecution = null
      }
    }
    assert.ok(executions.length >= 3, `expected three successful execution groups\n${await diagnostics()}`)
    const [textExecution, toolExecution, emptyExecution] = executions

    assert.ok(types.has("session.step.started"), `session.step.started missing\n${await diagnostics()}`)
    assert.ok(types.has("session.step.ended"), `session.step.ended missing\n${await diagnostics()}`)
    assert.ok(types.has("session.text.ended"), `session.text.ended missing\n${await diagnostics()}`)
    assert.ok(types.has("session.tool.input.started"), `session.tool.input.started missing\n${await diagnostics()}`)
    assert.ok(types.has("session.tool.called"), `session.tool.called missing\n${await diagnostics()}`)
    assert.ok(types.has("session.tool.success"), `session.tool.success missing\n${await diagnostics()}`)
    assert.ok(types.has("session.usage.updated"), `session.usage.updated missing\n${await diagnostics()}`)

    const admissions = events.filter((item) => item.type === "session.inbox.enqueued")
    assert.ok(admissions.length >= 3, `exact 2.0.11 session.inbox.enqueued user admissions missing\n${await diagnostics()}`)
    assert.ok(admissions.slice(0, 3).every((item) => item?.data?.item?.type === "user"))
    const admission = admissions[0]

    const stepEnded = events.find((item) =>
      item.type === "session.step.ended"
      && typeof item?.data?.assistantMessageID === "string"
      && item?.data?.tokens
    )
    assert.ok(stepEnded, `step.ended lacks assistantMessageID/tokens\n${await diagnostics()}`)
    assert.equal(typeof stepEnded.data.cost, "number")

    const textEnded = textExecution.find((item) => item.type === "session.text.ended" && item?.data?.text === TEXT_PROBE)
    assert.ok(textEnded)
    assert.equal(typeof textEnded.data.assistantMessageID, "string")

    const toolStart = toolExecution.find((item) => item.type === "session.tool.input.started" && item?.data?.name === TOOL)
    assert.ok(toolStart)
    assert.equal(typeof toolStart.data.callID, "string")

    const toolCalled = toolExecution.find((item) =>
      item.type === "session.tool.called"
      && item?.data?.callID === toolStart.data.callID
    )
    assert.deepEqual(toolCalled?.data?.input, { value: "mutation-proof" })

    const toolSuccess = toolExecution.find((item) =>
      item.type === "session.tool.success"
      && item?.data?.callID === toolStart.data.callID
    )
    assert.ok(toolSuccess)
    assert.equal(toolSuccess.data.callID, toolStart.data.callID)

    const emptyMeaningful = emptyExecution.filter((item) =>
      (item.type === "session.text.ended" && String(item?.data?.text ?? "").trim())
      || item.type === "session.tool.input.started"
    )
    assert.deepEqual(emptyMeaningful, [], "fully empty execution must expose no text/tool activity")
    assert.ok(
      emptyExecution.some((item) => item.type === "session.step.ended" && item?.data?.tokens),
      "empty execution still needs billable step usage telemetry",
    )

    assert.equal(await readFile(path.join(workspace, "telemetry-progress.txt"), "utf8"), "mutation-proof")

    const contexts = trace.filter((item) => item.phase === "context" && item.sessionID === sessionID)
    assert.ok(contexts.length >= 3)
    const contextWithModel = contexts.find((item) => item.model)
    const usage = events.filter((item) => item.type === "session.usage.updated").at(-1)

    console.log(JSON.stringify({
      ok: true,
      version,
      sessionID,
      inputAdmissionType: admission.type,
      executionShapes: executions.slice(0, 3).map((group) => ({
        eventTypes: group.map((item) => item.type),
        stepEnded: group
          .filter((item) => item.type === "session.step.ended")
          .map((item) => ({ assistantMessageID: item.data?.assistantMessageID, tokens: item.data?.tokens, cost: item.data?.cost, files: item.data?.files })),
      })),
      eventTypes: [...types].sort(),
      stepEndedShape: {
        keys: Object.keys(stepEnded.data ?? {}).sort(),
        tokens: stepEnded.data.tokens,
        cost: stepEnded.data.cost,
        files: stepEnded.data.files,
      },
      toolShape: {
        startedKeys: Object.keys(toolStart.data ?? {}).sort(),
        calledKeys: Object.keys(toolCalled?.data ?? {}).sort(),
        successKeys: Object.keys(toolSuccess.data ?? {}).sort(),
        successMetadata: toolSuccess.data.metadata,
      },
      usageShape: usage ? {
        keys: Object.keys(usage.data ?? usage.properties ?? {}).sort(),
        data: usage.data,
        properties: usage.properties,
      } : null,
      contextShape: contextWithModel ? {
        keys: contextWithModel.keys,
        model: contextWithModel.model,
        options: contextWithModel.options,
      } : null,
      emptyCompletionProvedBy: "third execution succeeded without requiring text activity",
    }, null, 2))
  } finally {
    await stop(server)
    await p.close().catch(() => undefined)
    await rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }).catch(() => undefined)
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
