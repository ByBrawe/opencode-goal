import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { createServer } from "node:http"
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import process from "node:process"

const COMMAND = "goal-promotion-probe"
const MANAGED_GOAL_COMMAND = "goal"
const MANAGED_GOAL_SENTINEL = "MANAGED_GOAL_DIRECT_SENTINEL"
const IDENTITY_COMMAND = "goal-prompt-identity-probe"
const CAPABILITY_COMMAND = "goal-capability-probe"
const TOOL = "opencode_goal_v2_promotion_probe"
const CAPABILITY_TOOL = "opencode_goal_v2_capability_probe"
const DIRECT_SENTINEL = "DIRECT_COMMAND_SENTINEL"
const SPOOF_SENTINEL = "SPOOF_PROMPT_SENTINEL"
const IDENTITY_SENTINEL = "DIRECT_PROMPT_IDENTITY_SENTINEL"
const IDENTITY_SPOOF_SENTINEL = "SPOOF_PROMPT_IDENTITY_SENTINEL"
const CAPABILITY_SENTINEL = "DIRECT_SINGLE_USE_CAPABILITY_SENTINEL"
const CAPABILITY_FOLLOWUP_SENTINEL = "POST_CONSUMPTION_PROMPT_SENTINEL"
const CAPABILITY_SPOOF_SENTINEL = "SPOOF_SINGLE_USE_CAPABILITY_SENTINEL"
const SERVER_USERNAME = "opencode"
const SERVER_PASSWORD = "opencode-goal-v2-promotion-canary"
const OPENCODE_BINARY = process.env.OPENCODE2_BINARY || "opencode2"

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
    if (part?.type === "tool-result") return JSON.stringify(part)
    return ""
  }).join("\n")
}

function messageText(body) {
  return (Array.isArray(body?.messages) ? body.messages : []).map((message) => {
    return `${String(message?.role || "")}: ${contentText(message?.content)}`
  }).join("\n")
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

function streamToolCall(res, sequence) {
  const id = `chatcmpl-goal-v2-promotion-${sequence}`
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
          id: "call-goal-v2-promotion",
          type: "function",
          function: { name: TOOL, arguments: "" },
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
          function: { arguments: JSON.stringify({ value: "provider-call" }) },
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

function streamCapabilityToolCall(res, sequence) {
  const id = `chatcmpl-goal-v2-capability-${sequence}`
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
          id: "call-goal-v2-capability",
          type: "function",
          function: { name: CAPABILITY_TOOL, arguments: "" },
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
          function: { arguments: JSON.stringify({ value: "capability-call" }) },
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

function streamText(res, sequence, text) {
  const id = `chatcmpl-goal-v2-promotion-${sequence}`
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
    usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 },
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
    const names = toolNames(body)
    const text = messageText(body)
    stats.requests.push({
      sequence,
      tools: names,
      text: text.slice(-5000),
      hasProbeTool: names.includes(TOOL),
      hasCapabilityTool: names.includes(CAPABILITY_TOOL),
      sawSpoof: text.includes(SPOOF_SENTINEL),
      sawIdentity: text.includes(IDENTITY_SENTINEL),
      sawIdentitySpoof: text.includes(IDENTITY_SPOOF_SENTINEL),
      sawCapability: text.includes(CAPABILITY_SENTINEL),
      sawCapabilityFollowup: text.includes(CAPABILITY_FOLLOWUP_SENTINEL),
      sawCapabilitySpoof: text.includes(CAPABILITY_SPOOF_SENTINEL),
      sawToolResult: text.includes("PROMOTION_TOOL_EXECUTED") || text.includes("provider-call"),
      sawCapabilityToolResult: text.includes("CAPABILITY_TOOL_EXECUTED") || text.includes("capability-call"),
    })

    if (sequence === 1) {
      streamToolCall(res, sequence)
      return
    }
    if (names.includes(CAPABILITY_TOOL) && !text.includes("CAPABILITY_TOOL_EXECUTED")) {
      streamCapabilityToolCall(res, sequence)
      return
    }
    streamText(res, sequence, "PROMOTION_PROBE_DONE")
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

const traceFile = process.env.OPENCODE_GOAL_V2_PROMOTION_TRACE
const commandName = ${JSON.stringify(COMMAND)}
const managedGoalCommandName = ${JSON.stringify(MANAGED_GOAL_COMMAND)}
const identityCommandName = ${JSON.stringify(IDENTITY_COMMAND)}
const capabilityCommandName = ${JSON.stringify(CAPABILITY_COMMAND)}
const toolName = ${JSON.stringify(TOOL)}
const capabilityToolName = ${JSON.stringify(CAPABILITY_TOOL)}

async function trace(event) {
  await appendFile(traceFile, JSON.stringify({ at: Date.now(), ...event }) + "\\n", "utf8")
}

export default {
  id: "bybrawe.opencode-goal.v2.promotion-capability-canary",
  async setup(ctx) {
    await trace({ phase: "setup", app: ctx?.app })
    const capabilities = new Map()

    const commandRegistration = await ctx.command.transform((editor) => {
      editor.add({
        name: managedGoalCommandName,
        description: "OpenCode Goal managed /goal collision probe",
        async execute(input) {
          await trace({
            phase: "managed-goal.command.execute",
            sessionID: input?.sessionID,
            delivery: input?.delivery,
            prompt: input?.prompt,
          })
        },
      })

      editor.add({
        name: commandName,
        description: "OpenCode Goal V2 direct command origin probe",
        async execute(input) {
          await trace({
            phase: "command.execute",
            sessionID: input?.sessionID,
            delivery: input?.delivery,
            prompt: input?.prompt,
          })
        },
      })

      editor.add({
        name: identityCommandName,
        description: "OpenCode Goal V2 command-to-prompt identity probe",
        async execute(input) {
          await trace({
            phase: "identity.command.execute",
            sessionID: input?.sessionID,
            delivery: input?.delivery,
            prompt: input?.prompt,
          })

          const admitted = await ctx.session.prompt({
            sessionID: input.sessionID,
            text: input.prompt?.text ?? "",
            files: input.prompt?.files,
            agents: input.prompt?.agents,
            skills: input.prompt?.skills,
            delivery: input.delivery,
            resume: false,
          })
          const messageID = admitted?.id ?? admitted?.data?.id
          if (typeof messageID !== "string" || !messageID) {
            throw new Error("session.prompt(resume:false) did not return a host message id")
          }
          await trace({
            phase: "identity.prompt.admitted",
            sessionID: input.sessionID,
            messageID,
          })

          const resumed = await ctx.session.prompt({
            sessionID: input.sessionID,
            id: messageID,
            text: input.prompt?.text ?? "",
            files: input.prompt?.files,
            agents: input.prompt?.agents,
            skills: input.prompt?.skills,
            delivery: input.delivery,
            resume: true,
          })
          const resumedMessageID = resumed?.id ?? resumed?.data?.id
          await trace({
            phase: "identity.prompt.resumed",
            sessionID: input.sessionID,
            messageID: resumedMessageID,
          })
        },
      })

      editor.add({
        name: capabilityCommandName,
        description: "OpenCode Goal V2 single-use host-message capability probe",
        async execute(input) {
          await trace({
            phase: "capability.command.execute",
            sessionID: input?.sessionID,
            delivery: input?.delivery,
            prompt: input?.prompt,
          })

          const admitted = await ctx.session.prompt({
            sessionID: input.sessionID,
            text: input.prompt?.text ?? "",
            files: input.prompt?.files,
            agents: input.prompt?.agents,
            skills: input.prompt?.skills,
            delivery: input.delivery,
            resume: false,
          })
          const messageID = admitted?.id ?? admitted?.data?.id
          if (typeof messageID !== "string" || !messageID) {
            throw new Error("capability command did not receive a host user-message id")
          }

          capabilities.set(input.sessionID, {
            messageID,
            state: "armed",
            exposures: 0,
          })
          await trace({
            phase: "capability.armed",
            sessionID: input.sessionID,
            messageID,
          })

          const resumed = await ctx.session.prompt({
            sessionID: input.sessionID,
            id: messageID,
            text: input.prompt?.text ?? "",
            files: input.prompt?.files,
            agents: input.prompt?.agents,
            skills: input.prompt?.skills,
            delivery: input.delivery,
            resume: true,
          })
          await trace({
            phase: "capability.resumed",
            sessionID: input.sessionID,
            messageID: resumed?.id ?? resumed?.data?.id,
          })
        },
      })
    })

    const toolRegistration = await ctx.tool.transform((editor) => {
      editor.add({
        name: toolName,
        description: "OpenCode Goal V2 provider-visible tool materialization probe",
        input: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        output: {
          type: "object",
          properties: { echo: { type: "string" } },
          required: ["echo"],
          additionalProperties: false,
        },
        options: { codemode: false },
        async execute(input, context) {
          await trace({
            phase: "tool.execute",
            input,
            sessionID: context?.sessionID,
            agent: context?.agent,
            messageID: context?.messageID,
            callID: context?.id,
          })
          return {
            output: { echo: String(input?.value || "") },
            content: "PROMOTION_TOOL_EXECUTED " + String(input?.value || ""),
          }
        },
      })

      editor.add({
        name: capabilityToolName,
        description: "OpenCode Goal V2 single-use control capability probe",
        input: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        output: {
          type: "object",
          properties: {
            accepted: { type: "boolean" },
            state: { type: "string" },
          },
          required: ["accepted", "state"],
          additionalProperties: false,
        },
        options: { codemode: false },
        async execute(input, context) {
          const capability = capabilities.get(context?.sessionID)
          const accepted = capability?.state === "offered"
          if (accepted) capability.state = "consumed"
          await trace({
            phase: accepted ? "capability.consumed" : "capability.rejected",
            sessionID: context?.sessionID,
            assistantMessageID: context?.messageID,
            callID: context?.id,
            input,
            capabilityMessageID: capability?.messageID,
            state: capability?.state ?? "missing",
          })
          return {
            output: {
              accepted,
              state: capability?.state ?? "missing",
            },
            content: accepted
              ? "CAPABILITY_TOOL_EXECUTED " + String(input?.value || "")
              : "CAPABILITY_TOOL_REJECTED",
          }
        },
      })
    })

    const promptRegistration = await ctx.session.hook("prompt", async (event) => {
      await trace({
        phase: "session.prompt",
        sessionID: event?.sessionID,
        messageID: event?.messageID,
        delivery: event?.delivery,
        prompt: event?.prompt,
      })
    })

    const contextRegistration = await ctx.session.hook("context", async (event) => {
      const messages = Array.isArray(event?.messages) ? event.messages : []
      const userMessages = messages.filter((message) => message?.role === "user" && typeof message?.id === "string")
      const currentUserMessageID = userMessages.at(-1)?.id
      const capability = capabilities.get(event?.sessionID)
      const matchingArmedMessage = capability
        && (capability.state === "armed" || capability.state === "offered")
        && currentUserMessageID === capability.messageID

      if (matchingArmedMessage) {
        capability.state = "offered"
        capability.exposures += 1
      } else if (event?.tools && typeof event.tools === "object") {
        delete event.tools[capabilityToolName]
        if (
          capability
          && (capability.state === "armed" || capability.state === "offered")
          && currentUserMessageID
          && currentUserMessageID !== capability.messageID
        ) {
          capability.state = "invalidated"
        }
      }

      await trace({
        phase: "session.context",
        sessionID: event?.sessionID,
        tools: event?.tools && typeof event.tools === "object" ? Object.keys(event.tools) : [],
        currentUserMessageID,
        capabilityMessageID: capability?.messageID,
        capabilityState: capability?.state ?? "missing",
        capabilityExposures: capability?.exposures ?? 0,
        capabilityToolVisible: Boolean(event?.tools?.[capabilityToolName]),
        messages: messages.map((message) => ({
          id: message?.id,
          role: message?.role,
          metadata: message?.metadata,
        })),
      })
    })

    try {
      const tools = await ctx.tool.list()
      await trace({
        phase: "tool.list",
        tools: Array.isArray(tools) ? tools.map((item) => item?.id || item?.name).filter(Boolean) : [],
      })
    } catch (error) {
      await trace({ phase: "tool.list.error", error: String(error) })
    }

    return async () => {
      await contextRegistration?.dispose?.()
      await promptRegistration?.dispose?.()
      await toolRegistration?.dispose?.()
      await commandRegistration?.dispose?.()
    }
  },
}
`
}

function commandNames(payload) {
  const data = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : []
  return new Set(data.map((item) => item?.name ?? item?.id).filter((name) => typeof name === "string"))
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
  assert.equal(process.platform, "linux", "the exact OpenCode 2 promotion capability canary is intentionally Ubuntu-only")

  const workspace = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-v2-promotion-"))
  const home = path.join(workspace, ".home")
  const pluginDir = path.join(workspace, ".opencode", "plugins")
  const traceFile = path.join(workspace, "promotion-trace.jsonl")
  const provider = startProvider()
  const providerPort = await provider.listen()

  let server
  let serverLog = ""
  let apiPrefix = null
  let managedGoalSessionID = ""
  let commandSessionID = ""
  let promptSessionID = ""
  let identitySessionID = ""
  let identitySpoofSessionID = ""
  let capabilitySessionID = ""
  let capabilitySpoofSessionID = ""
  let latestCommands = new Set()

  await Promise.all([
    mkdir(pluginDir, { recursive: true }),
    mkdir(path.join(home, ".config"), { recursive: true }),
    mkdir(path.join(home, ".config", "opencode", "commands"), { recursive: true }),
    mkdir(path.join(home, ".local", "share"), { recursive: true }),
    mkdir(path.join(home, ".local", "state"), { recursive: true }),
    mkdir(path.join(home, ".cache"), { recursive: true }),
  ])

  await writeFile(path.join(pluginDir, "opencode-goal-v2-promotion-probe.js"), pluginSource(), "utf8")
  // OpenCode 2 installer mode intentionally leaves commands/goal.md absent.
  // A markdown command with the same name shadows the plugin-native command on
  // exact 2.0.11, so this canary exercises the production V2 post-install shape.
  await writeFile(path.join(workspace, "README.md"), "# OpenCode Goal V2 promotion capability canary\n", "utf8")
  await writeFile(path.join(workspace, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "canary/canary",
    providers: {
      canary: {
        name: "Deterministic OpenCode Goal V2 Promotion Canary",
        package: "@opencode-ai/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${providerPort}/v1` },
        models: {
          canary: {
            name: "Deterministic OpenCode Goal V2 Promotion Canary",
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
    OPENCODE_GOAL_V2_PROMOTION_TRACE: traceFile,
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
      `commands=${JSON.stringify([...latestCommands])}`,
      `managedGoalSessionID=${managedGoalSessionID || "none"}`,
      `commandSessionID=${commandSessionID || "none"}`,
      `promptSessionID=${promptSessionID || "none"}`,
      `identitySessionID=${identitySessionID || "none"}`,
      `identitySpoofSessionID=${identitySpoofSessionID || "none"}`,
      `capabilitySessionID=${capabilitySessionID || "none"}`,
      `capabilitySpoofSessionID=${capabilitySpoofSessionID || "none"}`,
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
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        let response
        try {
          response = await request(`${prefix}/command`, { method: "GET" }, 5_000)
        } catch {}
        if (response?.ok) {
          apiPrefix = prefix
          break
        }
        if (response && ![404, 503].includes(response.status)) {
          throw new Error(`command registry probe failed with HTTP ${response.status}: ${response.text}\n${await diagnostics()}`)
        }
        if (response?.status === 404) break
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      if (apiPrefix !== null) break
    }
    assert.notEqual(apiPrefix, null, `OpenCode 2 command API never became ready\n${await diagnostics()}`)

    await waitFor(async () => {
      const response = await request(`${apiPrefix}/command`, { method: "GET" }, 5_000)
      if (!response.ok) return false
      latestCommands = commandNames(response.body)
      return latestCommands.has(MANAGED_GOAL_COMMAND)
        && latestCommands.has(COMMAND)
        && latestCommands.has(IDENTITY_COMMAND)
        && latestCommands.has(CAPABILITY_COMMAND)
    }, "direct probe command registration", diagnostics, 30_000)

    const createSession = async (title) => {
      const response = await request(`${apiPrefix}/session`, {
        method: "POST",
        body: JSON.stringify({ title }),
      })
      if (!response.ok) throw new Error(`session create failed: HTTP ${response.status} ${response.text}\n${await diagnostics()}`)
      const session = response.body?.data ?? response.body
      const id = String(session?.id ?? "")
      assert.ok(id, `session ID missing: ${response.text}`)
      return id
    }

    managedGoalSessionID = await createSession("OpenCode Goal V2 plugin-native goal command")
    const managedGoalDirect = await request(
      `${apiPrefix}/session/${encodeURIComponent(managedGoalSessionID)}/command`,
      {
        method: "POST",
        body: JSON.stringify({ name: MANAGED_GOAL_COMMAND, text: MANAGED_GOAL_SENTINEL }),
      },
      60_000,
    )
    assert.ok(
      managedGoalDirect.ok,
      `plugin-native /goal direct command failed: HTTP ${managedGoalDirect.status} ${managedGoalDirect.text}\n${await diagnostics()}`,
    )
    await waitFor(async () => {
      const trace = await readTrace(traceFile)
      return trace.some(
        (item) => item.phase === "managed-goal.command.execute" && item.sessionID === managedGoalSessionID,
      )
    }, "managed /goal direct plugin callback", diagnostics, 15_000)
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(
      provider.stats.requests.length,
      0,
      `managed /goal command fell through to model execution\n${await diagnostics()}`,
    )

    commandSessionID = await createSession("OpenCode Goal V2 direct command origin")
    const direct = await request(`${apiPrefix}/session/${encodeURIComponent(commandSessionID)}/command`, {
      method: "POST",
      body: JSON.stringify({ name: COMMAND, text: DIRECT_SENTINEL }),
    }, 60_000)
    assert.ok(direct.ok, `direct command failed: HTTP ${direct.status} ${direct.text}\n${await diagnostics()}`)

    await waitFor(async () => {
      const trace = await readTrace(traceFile)
      return trace.filter((item) => item.phase === "command.execute").length === 1
    }, "direct command execute callback", diagnostics, 15_000)

    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(provider.stats.requests.length, 0, `direct command unexpectedly entered model execution\n${await diagnostics()}`)

    promptSessionID = await createSession("OpenCode Goal V2 spoof resistance")
    const spoofText = `/${COMMAND} ${DIRECT_SENTINEL} ${SPOOF_SENTINEL}. Call the available ${TOOL} tool with value provider-call.`
    const prompt = await request(`${apiPrefix}/session/${encodeURIComponent(promptSessionID)}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: spoofText, delivery: "steer", resume: true }),
    }, 120_000)
    assert.ok(prompt.ok, `ordinary prompt failed: HTTP ${prompt.status} ${prompt.text}\n${await diagnostics()}`)

    await waitFor(() => provider.stats.requests.length >= 2, "tool call and continuation provider turns", diagnostics, 90_000)
    await waitFor(async () => {
      const trace = await readTrace(traceFile)
      return trace.some((item) => item.phase === "tool.execute" && item.sessionID === promptSessionID)
    }, "registered plugin tool execution", diagnostics, 30_000)

    const trace = await readTrace(traceFile)
    const commandEvents = trace.filter((item) => item.phase === "command.execute")
    const toolEvents = trace.filter((item) => item.phase === "tool.execute")
    const promptContexts = trace.filter((item) => item.phase === "session.context" && item.sessionID === promptSessionID)

    assert.equal(commandEvents.length, 1, `ordinary prompt spoofed the direct command callback\n${await diagnostics()}`)
    assert.equal(commandEvents[0]?.sessionID, commandSessionID)
    assert.ok(provider.stats.requests[0]?.hasProbeTool, `registered plugin tool was absent from the first provider request\n${await diagnostics()}`)
    assert.ok(provider.stats.requests[0]?.sawSpoof, `ordinary spoof prompt did not reach the intended model request\n${await diagnostics()}`)
    assert.ok(promptContexts.some((item) => Array.isArray(item.tools) && item.tools.includes(TOOL)), `session.context did not expose the registered plugin tool\n${await diagnostics()}`)
    assert.ok(toolEvents.some((item) => item.sessionID === promptSessionID && item.input?.value === "provider-call"), `provider tool call did not settle through the plugin execute callback\n${await diagnostics()}`)
    assert.ok(provider.stats.requests[1]?.sawToolResult, `tool result did not reach the continuation request\n${await diagnostics()}`)

    identitySessionID = await createSession("OpenCode Goal V2 command prompt identity")
    const identityDirect = await request(`${apiPrefix}/session/${encodeURIComponent(identitySessionID)}/command`, {
      method: "POST",
      body: JSON.stringify({ name: IDENTITY_COMMAND, text: IDENTITY_SENTINEL }),
    }, 120_000)
    assert.ok(identityDirect.ok, `identity command failed: HTTP ${identityDirect.status} ${identityDirect.text}\n${await diagnostics()}`)

    await waitFor(async () => {
      const events = await readTrace(traceFile)
      return events.some((item) => item.phase === "identity.prompt.resumed" && item.sessionID === identitySessionID)
    }, "direct-command prompt admission and exact-ID resume", diagnostics, 30_000)
    await waitFor(
      () => provider.stats.requests.some((item) => item.sawIdentity),
      "provider request for direct-command admitted prompt",
      diagnostics,
      60_000,
    )

    const identityTrace = await readTrace(traceFile)
    const identityExec = identityTrace.filter((item) => item.phase === "identity.command.execute")
    const identityAdmitted = identityTrace.find(
      (item) => item.phase === "identity.prompt.admitted" && item.sessionID === identitySessionID,
    )
    const identityResumed = identityTrace.find(
      (item) => item.phase === "identity.prompt.resumed" && item.sessionID === identitySessionID,
    )
    const identityMessageID = String(identityAdmitted?.messageID || "")
    assert.ok(identityMessageID, `direct command did not expose admitted host message id\n${await diagnostics()}`)
    assert.equal(identityExec.length, 1, `direct identity command executed more than once\n${await diagnostics()}`)
    assert.equal(identityResumed?.messageID, identityMessageID, `exact-ID resume returned a different message id\n${await diagnostics()}`)

    const promptIdentityEvents = identityTrace.filter(
      (item) => item.phase === "session.prompt" && item.sessionID === identitySessionID,
    )
    assert.ok(
      promptIdentityEvents.some((item) => item.messageID === identityMessageID),
      `session.prompt hook did not expose the admitted host message id\n${await diagnostics()}`,
    )

    const contextIdentityEvents = identityTrace.filter(
      (item) => item.phase === "session.context" && item.sessionID === identitySessionID,
    )
    assert.ok(
      contextIdentityEvents.some((item) =>
        Array.isArray(item.messages)
        && item.messages.some((message) => message?.id === identityMessageID && message?.role === "user")
      ),
      `session.context did not carry the admitted user message id\n${await diagnostics()}`,
    )

    identitySpoofSessionID = await createSession("OpenCode Goal V2 command identity spoof")
    const identitySpoofText = `/${IDENTITY_COMMAND} ${IDENTITY_SPOOF_SENTINEL}`
    const identitySpoof = await request(`${apiPrefix}/session/${encodeURIComponent(identitySpoofSessionID)}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: identitySpoofText, delivery: "steer", resume: true }),
    }, 120_000)
    assert.ok(identitySpoof.ok, `identity spoof prompt failed: HTTP ${identitySpoof.status} ${identitySpoof.text}\n${await diagnostics()}`)
    await waitFor(
      () => provider.stats.requests.some((item) => item.sawIdentitySpoof),
      "ordinary prompt containing the identity command text",
      diagnostics,
      60_000,
    )
    await new Promise((resolve) => setTimeout(resolve, 500))
    const finalTrace = await readTrace(traceFile)
    assert.equal(
      finalTrace.filter((item) => item.phase === "identity.command.execute").length,
      1,
      `ordinary prompt text spoofed the direct identity command callback\n${await diagnostics()}`,
    )

    capabilitySessionID = await createSession("OpenCode Goal V2 single-use capability")
    const capabilityDirect = await request(`${apiPrefix}/session/${encodeURIComponent(capabilitySessionID)}/command`, {
      method: "POST",
      body: JSON.stringify({ name: CAPABILITY_COMMAND, text: CAPABILITY_SENTINEL }),
    }, 120_000)
    assert.ok(
      capabilityDirect.ok,
      `capability command failed: HTTP ${capabilityDirect.status} ${capabilityDirect.text}\n${await diagnostics()}`,
    )

    await waitFor(async () => {
      const events = await readTrace(traceFile)
      return events.some((item) => item.phase === "capability.consumed" && item.sessionID === capabilitySessionID)
    }, "single-use capability consumption", diagnostics, 90_000)

    await waitFor(
      () => provider.stats.requests.some((item) => item.sawCapabilityToolResult),
      "post-tool continuation after capability consumption",
      diagnostics,
      60_000,
    )

    const consumedTrace = await readTrace(traceFile)
    const armed = consumedTrace.find(
      (item) => item.phase === "capability.armed" && item.sessionID === capabilitySessionID,
    )
    const capabilityMessageID = String(armed?.messageID || "")
    assert.ok(capabilityMessageID, `capability command did not arm a host message id\n${await diagnostics()}`)

    const capabilityContexts = consumedTrace.filter(
      (item) => item.phase === "session.context" && item.sessionID === capabilitySessionID,
    )
    assert.ok(
      capabilityContexts.some((item) =>
        item.currentUserMessageID === capabilityMessageID
        && item.capabilityToolVisible === true
        && item.capabilityState === "offered"
      ),
      `control capability was not exposed for the armed host user message\n${await diagnostics()}`,
    )

    const capabilityRequests = provider.stats.requests.filter((item) => item.sawCapability)
    assert.ok(capabilityRequests.length >= 1, `provider never saw capability command prompt\n${await diagnostics()}`)
    assert.equal(
      capabilityRequests[0]?.hasCapabilityTool,
      true,
      `armed provider request did not contain capability tool\n${await diagnostics()}`,
    )

    const consumedEvents = consumedTrace.filter(
      (item) => item.phase === "capability.consumed" && item.sessionID === capabilitySessionID,
    )
    assert.equal(consumedEvents.length, 1, `capability executed more than once\n${await diagnostics()}`)

    const continuationRequest = provider.stats.requests.find((item) => item.sawCapabilityToolResult)
    assert.ok(continuationRequest, `capability tool result did not reach continuation\n${await diagnostics()}`)
    assert.equal(
      continuationRequest.hasCapabilityTool,
      false,
      `consumed capability remained model-visible on the post-tool continuation\n${await diagnostics()}`,
    )

    const followup = await request(`${apiPrefix}/session/${encodeURIComponent(capabilitySessionID)}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: CAPABILITY_FOLLOWUP_SENTINEL, delivery: "steer", resume: true }),
    }, 120_000)
    assert.ok(followup.ok, `post-consumption prompt failed: HTTP ${followup.status} ${followup.text}\n${await diagnostics()}`)
    await waitFor(
      () => provider.stats.requests.some((item) => item.sawCapabilityFollowup),
      "ordinary post-consumption provider request",
      diagnostics,
      60_000,
    )
    const followupRequest = provider.stats.requests.find((item) => item.sawCapabilityFollowup)
    assert.equal(
      followupRequest?.hasCapabilityTool,
      false,
      `later ordinary request reused consumed capability\n${await diagnostics()}`,
    )

    capabilitySpoofSessionID = await createSession("OpenCode Goal V2 capability command spoof")
    const capabilitySpoof = await request(
      `${apiPrefix}/session/${encodeURIComponent(capabilitySpoofSessionID)}/prompt`,
      {
        method: "POST",
        body: JSON.stringify({
          text: `/${CAPABILITY_COMMAND} ${CAPABILITY_SPOOF_SENTINEL}`,
          delivery: "steer",
          resume: true,
        }),
      },
      120_000,
    )
    assert.ok(
      capabilitySpoof.ok,
      `capability spoof prompt failed: HTTP ${capabilitySpoof.status} ${capabilitySpoof.text}\n${await diagnostics()}`,
    )
    await waitFor(
      () => provider.stats.requests.some((item) => item.sawCapabilitySpoof),
      "ordinary prompt containing capability command text",
      diagnostics,
      60_000,
    )
    const spoofRequest = provider.stats.requests.find((item) => item.sawCapabilitySpoof)
    assert.equal(spoofRequest?.hasCapabilityTool, false, `spoof request minted a capability\n${await diagnostics()}`)

    const capabilityFinalTrace = await readTrace(traceFile)
    assert.equal(
      capabilityFinalTrace.filter((item) => item.phase === "capability.command.execute").length,
      1,
      `ordinary prompt text spoofed capability command callback\n${await diagnostics()}`,
    )
    assert.equal(
      capabilityFinalTrace.filter((item) => item.phase === "capability.consumed").length,
      1,
      `capability was replayed after consumption\n${await diagnostics()}`,
    )

    assert.equal(server.exitCode, null, `OpenCode 2 server exited during capability canary\n${await diagnostics()}`)

    console.log(JSON.stringify({
      ok: true,
      version,
      apiPrefix,
      managedGoalSessionID,
      commandSessionID,
      promptSessionID,
      identitySessionID,
      identitySpoofSessionID,
      capabilitySessionID,
      capabilitySpoofSessionID,
      managedGoalCommand: MANAGED_GOAL_COMMAND,
      managedGoalDirectIntercepted: true,
      registeredCommand: COMMAND,
      identityCommand: IDENTITY_COMMAND,
      capabilityCommand: CAPABILITY_COMMAND,
      registeredTool: TOOL,
      capabilityTool: CAPABILITY_TOOL,
      directCommandExecutions: commandEvents.length,
      providerRequests: provider.stats.requests.map((item) => ({
        sequence: item.sequence,
        tools: item.tools,
        hasProbeTool: item.hasProbeTool,
        hasCapabilityTool: item.hasCapabilityTool,
        sawSpoof: item.sawSpoof,
        sawCapability: item.sawCapability,
        sawCapabilityFollowup: item.sawCapabilityFollowup,
        sawCapabilitySpoof: item.sawCapabilitySpoof,
        sawToolResult: item.sawToolResult,
        sawCapabilityToolResult: item.sawCapabilityToolResult,
      })),
      contextSawProbeTool: promptContexts.some((item) => item.tools.includes(TOOL)),
      toolExecution: toolEvents.find((item) => item.sessionID === promptSessionID),
      spoofTriggeredCommand: commandEvents.some((item) => item.sessionID === promptSessionID),
      identityMessageID,
      identityPromptHookMatched: promptIdentityEvents.some((item) => item.messageID === identityMessageID),
      identityContextMatched: contextIdentityEvents.some((item) =>
        Array.isArray(item.messages)
        && item.messages.some((message) => message?.id === identityMessageID && message?.role === "user")
      ),
      identitySpoofTriggeredCommand: finalTrace.filter((item) => item.phase === "identity.command.execute").length !== 1,
      capabilityMessageID,
      capabilityConsumedOnce: capabilityFinalTrace.filter((item) => item.phase === "capability.consumed").length === 1,
      capabilityContinuationHidden: continuationRequest.hasCapabilityTool === false,
      capabilityFollowupHidden: followupRequest?.hasCapabilityTool === false,
      capabilitySpoofHidden: spoofRequest?.hasCapabilityTool === false,
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
