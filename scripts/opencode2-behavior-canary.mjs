import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const CONTROL_TOOL = "opencode_goals_v2_control"
const GET_TOOL = "opencode_goals_v2_get"
const COMMAND_PREAMBLE = "OpenCode Goals V2 command wrapper."
const BUILD_ARGS = 'v2 real behavior canary --success "state persisted"'
const PLAN_ARGS = 'v2 real plan canary --success "state persisted paused"'
const FOLLOW_UP = "ordinary follow-up after the Goal command"

function appendLog(current, chunk, limit = 80_000) {
  return (current + String(chunk)).slice(-limit)
}

async function run(command, args, { cwd, env, allowFailure = false, timeout = 90_000 } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      shell: process.platform === "win32",
    })
    let stdout = ""
    let stderr = ""
    let settled = false
    child.stdout?.on("data", (chunk) => { stdout = appendLog(stdout, chunk) })
    child.stderr?.on("data", (chunk) => { stderr = appendLog(stderr, chunk) })

    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(reject, new Error(`command timed out: ${command} ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, timeout)

    child.once("error", (error) => finish(reject, error))
    child.once("close", (code) => {
      const result = { status: code, stdout, stderr }
      if (!allowFailure && code !== 0) {
        finish(reject, new Error(`command failed (${code}): ${command} ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
        return
      }
      finish(resolve, result)
    })
  })
}

function parseJSON(result, label) {
  const text = String(result.stdout ?? "").trim()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label} did not return JSON.\nstdout:\n${text}\nstderr:\n${String(result.stderr ?? "")}`)
  }
}

function toolNames(body) {
  if (Array.isArray(body?.tools)) {
    return new Set(body.tools.map((item) => String(item?.function?.name ?? item?.name ?? "")).filter(Boolean))
  }
  if (body?.tools && typeof body.tools === "object") return new Set(Object.keys(body.tools))
  return new Set()
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

function latestUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (String(message?.role ?? "").toLowerCase() !== "user") continue
    const text = contentText(message?.content)
    if (text) return text
  }
  return ""
}

function hasToolResult(body) {
  return (body?.messages ?? []).some((message) => String(message?.role ?? "").toLowerCase() === "tool")
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

function jsonText(res, { id, created, content }) {
  res.writeHead(200, { "content-type": "application/json" })
  res.end(JSON.stringify({
    id,
    object: "chat.completion",
    created,
    model: "canary",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 32, completion_tokens: 4, total_tokens: 36 },
  }))
}

function streamText(res, { id, created, content }) {
  streamHeaders(res)
  writeSse(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model: "canary",
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
  })
  writeSse(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model: "canary",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 32, completion_tokens: 4, total_tokens: 36 },
  })
  res.end("data: [DONE]\n\n")
}

function jsonToolCall(res, { id, created, callID, name, args }) {
  res.writeHead(200, { "content-type": "application/json" })
  res.end(JSON.stringify({
    id,
    object: "chat.completion",
    created,
    model: "canary",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id: callID, type: "function", function: { name, arguments: JSON.stringify(args) } }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
  }))
}

function streamToolCall(res, { id, created, callID, name, args }) {
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
        tool_calls: [{ index: 0, id: callID, type: "function", function: { name, arguments: "" } }],
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
      delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] },
      finish_reason: null,
    }],
  })
  writeSse(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model: "canary",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
  })
  res.end("data: [DONE]\n\n")
}

function startProvider() {
  const stats = {
    chatRequests: 0,
    commandFirstSteps: 0,
    commandSecondSteps: 0,
    controlToolCallsRequested: 0,
    replayExposure: 0,
    ordinaryRequests: 0,
    ordinaryControlExposure: 0,
    getToolVisibleOnOrdinary: false,
    paths: [],
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    stats.paths.push(`${req.method} ${url.pathname}`)
    if (req.method === "GET" && url.pathname.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ object: "list", data: [{ id: "canary", object: "model", owned_by: "canary" }] }))
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
    stats.chatRequests += 1
    const id = `chatcmpl-v2-behavior-${stats.chatRequests}`
    const created = Math.floor(Date.now() / 1000)
    const tools = toolNames(body)
    const latest = latestUserText(body)
    const commandArgs = latest.includes(BUILD_ARGS) ? BUILD_ARGS : latest.includes(PLAN_ARGS) ? PLAN_ARGS : undefined
    const isCommand = latest.includes(COMMAND_PREAMBLE) && Boolean(commandArgs)
    const secondStep = hasToolResult(body)

    const sendText = (content) => body.stream ? streamText(res, { id, created, content }) : jsonText(res, { id, created, content })
    const sendTool = (name, args) => body.stream
      ? streamToolCall(res, { id, created, callID: `call-v2-${stats.chatRequests}`, name, args })
      : jsonToolCall(res, { id, created, callID: `call-v2-${stats.chatRequests}`, name, args })

    if (isCommand && !secondStep) {
      stats.commandFirstSteps += 1
      if (!tools.has(CONTROL_TOOL)) {
        res.writeHead(500, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: { message: "authorized /goal request did not expose V2 control tool" } }))
        return
      }
      stats.controlToolCallsRequested += 1
      sendTool(CONTROL_TOOL, { arguments: commandArgs })
      return
    }

    if (isCommand && secondStep) {
      stats.commandSecondSteps += 1
      if (tools.has(CONTROL_TOOL)) stats.replayExposure += 1
      sendText("V2 command control result accepted.")
      return
    }

    if (latest.includes(FOLLOW_UP)) {
      stats.ordinaryRequests += 1
      if (tools.has(CONTROL_TOOL)) stats.ordinaryControlExposure += 1
      if (tools.has(GET_TOOL)) stats.getToolVisibleOnOrdinary = true
      sendText("ordinary follow-up complete")
      return
    }

    sendText("V2_CANARY_OK")
  })

  return {
    stats,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", resolve)
      })
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("failed to start deterministic V2 provider")
      return address.port
    },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

async function readGoals(project) {
  const dir = path.join(project, ".opencode", "goals")
  try {
    const files = (await readdir(dir)).filter((name) => name.endsWith(".json"))
    const output = []
    for (const name of files) output.push(JSON.parse(await readFile(path.join(dir, name), "utf8")))
    return output
  } catch (error) {
    if (error?.code === "ENOENT") return []
    throw error
  }
}

async function goalFor(project, sessionID) {
  return (await readGoals(project)).find((goal) => goal?.sessionID === sessionID) ?? null
}

async function failureLog(env) {
  const candidates = [
    path.join(env.XDG_DATA_HOME, "opencode", "log", "opencode.log"),
    path.join(env.XDG_STATE_HOME, "opencode", "log", "opencode.log"),
  ]
  for (const file of candidates) {
    try {
      return (await readFile(file, "utf8")).slice(-40_000)
    } catch {
      // Try next location.
    }
  }
  return ""
}

async function main() {
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-v2-behavior-"))
  const project = path.join(temp, "project")
  const home = path.join(temp, "home")
  const config = path.join(home, ".config")
  const data = path.join(home, ".local", "share")
  const state = path.join(home, ".local", "state")
  const pluginDirectory = path.join(project, ".opencode", "plugins")
  const pluginFile = path.join(root, "dist", "opencode2", "experimental.js")
  const provider = startProvider()
  const providerPort = await provider.listen()

  await Promise.all([
    mkdir(pluginDirectory, { recursive: true }),
    mkdir(config, { recursive: true }),
    mkdir(data, { recursive: true }),
    mkdir(state, { recursive: true }),
  ])

  await writeFile(
    path.join(pluginDirectory, "opencode-goals-v2-behavior.js"),
    `export { default } from ${JSON.stringify(pathToFileURL(pluginFile).href)}\n`,
  )
  await writeFile(path.join(project, "README.md"), "# OpenCode 2 behavior canary\n")
  await writeFile(path.join(project, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    model: "canary/canary",
    default_agent: "build",
    providers: {
      canary: {
        name: "Deterministic OpenCode 2 Behavior Canary",
        package: "@opencode-ai/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${providerPort}/v1` },
        models: {
          canary: {
            name: "Deterministic OpenCode 2 Behavior Canary",
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            limit: { context: 100000, output: 4096 },
          },
        },
      },
    },
  }, null, 2)}\n`)

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    XDG_STATE_HOME: state,
    OPENCODE_DB: path.join(data, "opencode", "opencode-v2-behavior.db"),
    OPENCODE_LOG_LEVEL: "DEBUG",
    CI: "true",
  }

  await run("git", ["init", "-q"], { cwd: project, env })
  await run("git", ["config", "user.name", "OpenCode Goals Canary"], { cwd: project, env })
  await run("git", ["config", "user.email", "opencode-goals-canary@example.invalid"], { cwd: project, env })
  await run("git", ["add", "."], { cwd: project, env })
  await run("git", ["commit", "-q", "-m", "initialize behavior canary workspace"], { cwd: project, env })

  const locationQuery = `location%5Bdirectory%5D=${encodeURIComponent(project)}`
  const api = async (method, pathname, payload, timeout = 90_000) => {
    const args = ["api", method, pathname]
    if (payload !== undefined) args.push("--data", JSON.stringify(payload))
    return await run("opencode2", args, { cwd: project, env, timeout })
  }

  try {
    await run("opencode2", ["service", "stop"], { cwd: project, env, allowFailure: true, timeout: 15_000 })
    const health = await api("get", "/api/health", undefined, 30_000)
    assert.ok(String(health.stdout).trim(), "OpenCode 2 health API returned no output")

    const commands = parseJSON(await api("get", `/api/command?${locationQuery}`), "GET /api/command")
    const commandItems = commands?.data ?? commands
    assert.ok(Array.isArray(commandItems), `OpenCode 2 command list is not an array: ${JSON.stringify(commands)}`)
    const goalCommand = commandItems.find((item) => item?.name === "goal")
    assert.ok(goalCommand, "real command.transform did not register/update /goal")
    assert.match(String(goalCommand.description ?? ""), /experimental OpenCode 2/i)
    assert.match(String(goalCommand.template ?? ""), /opencode_goals_v2_control/)

    const createSession = async (title) => {
      const created = parseJSON(
        await api("post", `/api/session?${locationQuery}`, { title }),
        `POST /api/session (${title})`,
      )
      const session = created?.data ?? created
      const sessionID = String(session?.id ?? "")
      assert.ok(sessionID, `OpenCode 2 did not create session for ${title}: ${JSON.stringify(created)}`)
      return sessionID
    }

    const sendGoal = async (sessionID, agent, argumentsText) => {
      return await api(
        "post",
        `/api/session/${encodeURIComponent(sessionID)}/command?${locationQuery}`,
        { agent, command: "goal", arguments: argumentsText },
        90_000,
      )
    }

    const buildSessionID = await createSession("v2 behavior build canary")
    await sendGoal(buildSessionID, "build", BUILD_ARGS)
    const buildGoal = await goalFor(project, buildSessionID)
    assert.ok(buildGoal, "real V2 control tool did not persist Build Goal state under project workspace")
    assert.equal(buildGoal.objective, "v2 real behavior canary")
    assert.equal(buildGoal.status, "active")
    assert.ok(buildGoal.requirements.some((item) => item.source === "acceptance" && item.text === "state persisted"))

    await api(
      "post",
      `/api/session/${encodeURIComponent(buildSessionID)}/message?${locationQuery}`,
      { agent: "build", parts: [{ type: "text", text: FOLLOW_UP }] },
      90_000,
    )

    const planSessionID = await createSession("v2 behavior plan canary")
    await sendGoal(planSessionID, "plan", PLAN_ARGS)
    const planGoal = await goalFor(project, planSessionID)
    assert.ok(planGoal, "real V2 control tool did not persist Plan Goal state under project workspace")
    assert.equal(planGoal.objective, "v2 real plan canary")
    assert.equal(planGoal.status, "paused")
    assert.match(planGoal.stopReason ?? "", /Plan is a restricted execution agent/i)

    assert.equal(provider.stats.commandFirstSteps, 2, `expected one first provider step per /goal command: ${JSON.stringify(provider.stats)}`)
    assert.equal(provider.stats.controlToolCallsRequested, 2, "provider should request exactly one control execution for each distinct /goal command")
    assert.ok(provider.stats.commandSecondSteps >= 2, "each real control execution should lead to a second model step")
    assert.equal(provider.stats.replayExposure, 0, "same command turn re-exposed the consumed V2 control capability")
    assert.ok(provider.stats.ordinaryRequests >= 1, "ordinary follow-up did not reach deterministic provider")
    assert.equal(provider.stats.ordinaryControlExposure, 0, "ordinary request exposed the mutating V2 control capability")
    assert.equal(provider.stats.getToolVisibleOnOrdinary, true, "ordinary request should retain the read-only V2 Goal get tool")

    console.log(JSON.stringify({
      ok: true,
      platform: process.platform,
      buildSessionID,
      planSessionID,
      buildStatus: buildGoal.status,
      planStatus: planGoal.status,
      provider: provider.stats,
    }, null, 2))
  } catch (error) {
    const logs = await failureLog(env)
    if (logs) console.error(`OpenCode 2 server log tail:\n${logs}`)
    throw error
  } finally {
    await run("opencode2", ["service", "stop"], { cwd: project, env, allowFailure: true, timeout: 15_000 }).catch(() => undefined)
    await provider.close().catch(() => undefined)
    await rm(temp, { recursive: true, force: true }).catch(() => undefined)
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
