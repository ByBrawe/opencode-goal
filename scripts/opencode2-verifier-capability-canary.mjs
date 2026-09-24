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
const SERVER_PASSWORD = "opencode-goal-v2-verifier-capability"
const COMMAND = "goal-verifier-capability"
const RESULT_TOOL = "opencode_goal_v2_verifier_capability_result"
const TOKEN = "V2_VERIFIER_CAPABILITY_TOKEN"

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

async function waitFor(predicate, description, diagnostics, timeoutMs = 45_000) {
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
  const id = `chatcmpl-v2-verifier-capability-${sequence}`
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

function streamResultTool(res, sequence) {
  const id = `chatcmpl-v2-verifier-capability-tool-${sequence}`
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
          id: `call-v2-verifier-capability-${sequence}`,
          type: "function",
          function: { name: RESULT_TOOL, arguments: "" },
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
          function: { arguments: JSON.stringify({ auditToken: TOKEN }) },
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
    usage: { prompt_tokens: 35, completion_tokens: 7, total_tokens: 42 },
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
    const verifier = current.userText.includes(TOKEN)
    const sawAcceptedResult = /Verifier capability result accepted/i.test(current.turnText)

    stats.requests.push({
      sequence,
      currentUserText: current.userText,
      tools,
      verifier,
      sawAcceptedResult,
    })

    if (verifier && !sawAcceptedResult && tools.includes(RESULT_TOOL)) {
      streamResultTool(res, sequence)
      return
    }
    streamText(res, sequence, verifier ? "VERIFIER_CAPABILITY_DONE" : "UNEXPECTED_NON_VERIFIER_TURN")
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

const traceFile = process.env.OPENCODE_GOAL_V2_VERIFIER_TRACE
const RESULT_TOOL = ${JSON.stringify(RESULT_TOOL)}
const COMMAND = ${JSON.stringify(COMMAND)}
const TOKEN = ${JSON.stringify(TOKEN)}
const verifierSessions = new Set()
const pending = new Map()

async function trace(event) {
  await appendFile(traceFile, JSON.stringify({ at: Date.now(), ...event }) + "\\n", "utf8")
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
}

function appendSystem(event, text) {
  if (!Array.isArray(event?.system)) return
  event.system.push({ type: "text", text })
}

function keepOnlyVerifierTools(event) {
  if (!event?.tools || typeof event.tools !== "object") return []
  const allowed = new Set(["read", "glob", "grep", RESULT_TOOL])
  for (const name of Object.keys(event.tools)) {
    if (!allowed.has(name)) delete event.tools[name]
  }
  return Object.keys(event.tools).sort()
}

export default {
  id: "bybrawe.opencode-goal.v2.verifier-capability",
  async setup(ctx) {
    await trace({
      phase: "setup",
      sessionCreate: typeof ctx.session?.create === "function",
      sessionPrompt: typeof ctx.session?.prompt === "function",
      sessionInterrupt: typeof ctx.session?.interrupt === "function",
      sessionDelete: typeof ctx.session?.delete === "function",
      sessionWait: typeof ctx.session?.wait === "function",
      toolTransform: typeof ctx.tool?.transform === "function",
      commandTransform: typeof ctx.command?.transform === "function",
    })

    await ctx.tool.transform((tools) => {
      tools.add({
        name: RESULT_TOOL,
        description: "Submit the exact-host verifier capability result.",
        input: {
          type: "object",
          properties: { auditToken: { type: "string" } },
          required: ["auditToken"],
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
          const request = pending.get(toolContext?.sessionID)
          if (!request || input?.auditToken !== request.token) {
            return { output: { message: "Rejected verifier capability result." }, content: "Rejected verifier capability result." }
          }
          await trace({ phase: "verifier.result", sessionID: toolContext.sessionID, auditToken: input.auditToken })
          request.resolve()
          return { output: { message: "Verifier capability result accepted." }, content: "Verifier capability result accepted." }
        },
      })
    })

    await ctx.session.hook("context", async (event) => {
      const sessionID = firstString(event?.sessionID)
      if (!sessionID) return
      if (!verifierSessions.has(sessionID)) {
        if (event?.tools && typeof event.tools === "object") delete event.tools[RESULT_TOOL]
        return
      }
      const tools = keepOnlyVerifierTools(event)
      appendSystem(event, "Independent verifier capability probe. Read-only tools only; submit through the verifier result tool.")
      await trace({ phase: "verifier.context", sessionID, tools })
    })

    await ctx.command.transform((commands) => {
      commands.add({
        name: COMMAND,
        description: "Exact OpenCode 2 verifier child-session capability probe.",
        execute: async ({ sessionID }) => {
          if (typeof ctx.session?.create !== "function" || typeof ctx.session?.prompt !== "function") {
            throw new Error("verifier capability requires session.create() and session.prompt()")
          }

          const created = await ctx.session.create({
            parentID: sessionID,
            title: "Goal verifier capability",
          })
          const childID = firstString(created?.id, created?.data?.id)
          if (!childID) throw new Error("verifier capability child session id missing")
          verifierSessions.add(childID)
          await trace({ phase: "verifier.child.created", parentSessionID: sessionID, childID })

          let resolveResult
          const result = new Promise((resolve) => { resolveResult = resolve })
          pending.set(childID, { token: TOKEN, resolve: resolveResult })

          try {
            const admitted = await ctx.session.prompt({
              sessionID: childID,
              text: "Audit this verifier capability and submit the exact token through the result tool: " + TOKEN,
              delivery: "steer",
              resume: false,
            })
            const messageID = firstString(admitted?.id, admitted?.data?.id)
            if (!messageID) throw new Error("verifier capability prompt admission id missing")
            await trace({ phase: "verifier.prompt.admitted", childID, messageID })

            await ctx.session.prompt({
              sessionID: childID,
              id: messageID,
              text: "Audit this verifier capability and submit the exact token through the result tool: " + TOKEN,
              delivery: "steer",
              resume: true,
            })

            await Promise.race([
              result,
              new Promise((_, reject) => setTimeout(() => reject(new Error("verifier capability result timed out")), 30_000)),
            ])
            if (typeof ctx.session?.wait === "function") {
              await Promise.race([
                ctx.session.wait({ sessionID: childID }),
                new Promise((_, reject) => setTimeout(() => reject(new Error("verifier capability session.wait timed out")), 30_000)),
              ])
              await trace({ phase: "verifier.wait.complete", childID })
            }
            await trace({ phase: "verifier.complete", childID })
          } finally {
            pending.delete(childID)
            verifierSessions.delete(childID)
            if (typeof ctx.session?.delete === "function") {
              try {
                await ctx.session.delete({ sessionID: childID })
                await trace({ phase: "verifier.child.deleted", childID, supported: true })
              } catch (error) {
                await trace({ phase: "verifier.child.delete.error", childID, error: String(error) })
              }
            } else {
              await trace({ phase: "verifier.child.deleted", childID, supported: false })
            }
          }
        },
      })
    })
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

function commandNames(payload) {
  const data = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : []
  return new Set(data.map((item) => item?.name ?? item?.id).filter((name) => typeof name === "string"))
}

async function main() {
  assert.equal(process.platform, "linux", "the exact OpenCode 2 verifier capability canary is intentionally Ubuntu-only")

  const workspace = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-v2-verifier-capability-"))
  const home = path.join(workspace, ".home")
  const pluginDir = path.join(workspace, ".opencode", "plugins")
  const traceFile = path.join(workspace, "verifier-trace.jsonl")
  const provider = startProvider()
  const providerPort = await provider.listen()

  let server
  let serverLog = ""
  let sessionID = ""
  let latestCommands = new Set()

  await Promise.all([
    mkdir(pluginDir, { recursive: true }),
    mkdir(path.join(home, ".config"), { recursive: true }),
    mkdir(path.join(home, ".local", "share"), { recursive: true }),
    mkdir(path.join(home, ".local", "state"), { recursive: true }),
    mkdir(path.join(home, ".cache"), { recursive: true }),
  ])

  await writeFile(path.join(pluginDir, "opencode-goal-v2-verifier-capability.js"), pluginSource(), "utf8")
  await writeFile(path.join(workspace, "README.md"), "# OpenCode Goal V2 verifier capability canary\n", "utf8")
  await writeFile(path.join(workspace, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "canary/canary",
    providers: {
      canary: {
        name: "Deterministic V2 Verifier Capability Provider",
        package: "@opencode-ai/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${providerPort}/v1` },
        models: {
          canary: {
            name: "Deterministic V2 Verifier Capability Provider",
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
    OPENCODE_GOAL_V2_VERIFIER_TRACE: traceFile,
    OPENCODE_SERVER_USERNAME: SERVER_USERNAME,
    OPENCODE_SERVER_PASSWORD: SERVER_PASSWORD,
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    CI: "true",
  }

  const diagnostics = async () => {
    const trace = await readTrace(traceFile)
    return [
      `sessionID=${sessionID || "none"}`,
      `commands=${JSON.stringify([...latestCommands])}`,
      `trace=${JSON.stringify(trace)}`,
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
      return latestCommands.has(COMMAND)
    }, "exact V2 verifier capability command", diagnostics, 30_000)

    const setup = (await readTrace(traceFile)).find((item) => item.phase === "setup")
    assert.equal(setup?.sessionCreate, true, `session.create unavailable\n${await diagnostics()}`)
    assert.equal(setup?.sessionPrompt, true, `session.prompt unavailable\n${await diagnostics()}`)
    assert.equal(setup?.sessionInterrupt, true, `session.interrupt unavailable\n${await diagnostics()}`)
    assert.equal(setup?.toolTransform, true)
    assert.equal(setup?.commandTransform, true)

    const created = await request("/api/session", {
      method: "POST",
      body: JSON.stringify({ title: "V2 verifier capability parent" }),
    })
    assert.ok(created.ok, `parent session create failed: HTTP ${created.status} ${created.text}\n${await diagnostics()}`)
    sessionID = String((created.body?.data ?? created.body)?.id ?? "")
    assert.ok(sessionID)

    const command = await request(`/api/session/${encodeURIComponent(sessionID)}/command`, {
      method: "POST",
      body: JSON.stringify({ name: COMMAND, text: "" }),
    }, 90_000)
    assert.ok(command.ok, `verifier capability command failed: HTTP ${command.status} ${command.text}\n${await diagnostics()}`)

    await waitFor(async () => {
      const trace = await readTrace(traceFile)
      return trace.some((item) => item.phase === "verifier.complete")
    }, "verifier child result completion", diagnostics, 60_000)

    const trace = await readTrace(traceFile)
    const child = trace.find((item) => item.phase === "verifier.child.created")
    const context = trace.find((item) => item.phase === "verifier.context")
    const result = trace.find((item) => item.phase === "verifier.result")
    assert.ok(child?.childID)
    assert.equal(child.parentSessionID, sessionID)
    assert.equal(result?.sessionID, child.childID)
    assert.deepEqual(context?.tools, ["glob", "grep", RESULT_TOOL, "read"].sort())

    const verifierRequests = provider.stats.requests.filter((item) => item.verifier)
    assert.ok(verifierRequests.length >= 1, `expected verifier provider request\n${await diagnostics()}`)
    const first = verifierRequests[0]
    assert.ok(first.tools.includes(RESULT_TOOL))
    for (const forbidden of ["write", "edit", "shell", "execute", "subagent"]) {
      assert.equal(first.tools.includes(forbidden), false, `forbidden verifier tool leaked: ${forbidden}`)
    }
    assert.ok(trace.some((item) => item.phase === "verifier.result" && item.sessionID === child.childID))
    assert.ok(trace.some((item) => item.phase === "verifier.wait.complete" && item.childID === child.childID))

    console.log(JSON.stringify({
      ok: true,
      version,
      sessionCreate: setup.sessionCreate,
      sessionPrompt: setup.sessionPrompt,
      sessionInterrupt: setup.sessionInterrupt,
      sessionDelete: setup.sessionDelete,
      sessionWait: setup.sessionWait,
      childParentBound: child.parentSessionID === sessionID,
      resultSessionBound: result.sessionID === child.childID,
      verifierTools: context.tools,
      forbiddenMutationToolsHidden: true,
      resultSubmitted: true,
      sessionWaitCompleted: trace.some((item) => item.phase === "verifier.wait.complete"),
      acceptedResultContinuationObserved: verifierRequests.some((item) => item.sawAcceptedResult),
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
