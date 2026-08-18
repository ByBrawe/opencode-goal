import assert from "node:assert/strict"
import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"
import { GoalStore } from "../dist/persistence/store.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const CONTROL_TOOL = "opencode_goals_v2_control"
const GET_TOOL = "opencode_goals_v2_get"
const BUILD_ARGS = 'ship v2 behavior --success "persisted on real host" --constraint "no stable claim" --check "echo ok"'
const PLAN_ARGS = 'plan v2 boundary --success "persisted paused" --constraint "no implementation in plan"'
const ORDINARY_TEXT = "ORDINARY_V2_REQUEST"

function appendLog(current, chunk, limit = 80_000) {
  return (current + String(chunk)).slice(-limit)
}

async function run(command, args, { cwd, env, allowFailure = false, timeout = 90_000 } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true })
    let stdout = ""
    let stderr = ""
    let settled = false
    child.stdout?.on("data", (chunk) => { stdout = appendLog(stdout, chunk) })
    child.stderr?.on("data", (chunk) => { stderr = appendLog(stderr, chunk) })
    const finish = (error, result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(new Error(`command timed out: ${command} ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, timeout)
    child.once("error", (error) => finish(error))
    child.once("close", (code) => {
      const result = { status: code ?? -1, stdout, stderr }
      if (!allowFailure && code !== 0) {
        finish(new Error(`command failed (${code}): ${command} ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
        return
      }
      finish(null, result)
    })
  })
}

function output(result) {
  return `${String(result.stdout ?? "")}\n${String(result.stderr ?? "")}`.trim()
}

function parseJSONOutput(result, label) {
  const text = String(result.stdout ?? "").trim()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label} did not return JSON on stdout.\nstdout:\n${text}\nstderr:\n${String(result.stderr ?? "")}`)
  }
}

function toolNames(body) {
  const tools = body?.tools
  if (Array.isArray(tools)) {
    return tools
      .map((item) => item?.function?.name ?? item?.name)
      .filter((item) => typeof item === "string")
  }
  if (tools && typeof tools === "object") return Object.keys(tools)
  return []
}

function messageText(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return ""
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map((item) => messageText(item, depth + 1)).join("\n")
  if (typeof value !== "object") return ""
  if (typeof value.text === "string") return value.text
  if (typeof value.content === "string") return value.content
  if (value.content) return messageText(value.content, depth + 1)
  if (value.parts) return messageText(value.parts, depth + 1)
  return ""
}

function allMessageText(body) {
  return (body?.messages ?? []).map((message) => messageText(message)).join("\n")
}

function hasToolResult(body) {
  return (body?.messages ?? []).some((message) => {
    const role = String(message?.role ?? "").toLowerCase()
    return role === "tool" || role === "tool_result"
  })
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
    usage: { prompt_tokens: 40, completion_tokens: 4, total_tokens: 44 },
  })
  res.end("data: [DONE]\n\n")
}

function streamToolCall(res, { id, created, argumentsText }) {
  streamHeaders(res)
  const callID = `call-v2-control-${id}`
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
        tool_calls: [{ index: 0, id: callID, type: "function", function: { name: CONTROL_TOOL, arguments: "" } }],
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
      delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ arguments: argumentsText }) } }] },
      finish_reason: null,
    }],
  })
  writeSse(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model: "canary",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 50, completion_tokens: 12, total_tokens: 62 },
  })
  res.end("data: [DONE]\n\n")
}

function startProvider() {
  const stats = {
    requests: 0,
    buildAuthorizedRequests: 0,
    planAuthorizedRequests: 0,
    controlToolCalls: 0,
    postToolControlExposures: 0,
    ordinaryControlExposures: 0,
    getToolExposures: 0,
    observedToolNames: [],
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
    stats.requests += 1
    const id = `chatcmpl-v2-behavior-${stats.requests}`
    const created = Math.floor(Date.now() / 1000)
    const names = toolNames(body)
    const text = allMessageText(body)
    const toolResult = hasToolResult(body)
    stats.observedToolNames.push(names)
    if (names.includes(GET_TOOL)) stats.getToolExposures += 1

    const commandArgs = text.includes(BUILD_ARGS) ? BUILD_ARGS : text.includes(PLAN_ARGS) ? PLAN_ARGS : null
    if (commandArgs) {
      if (toolResult) {
        if (names.includes(CONTROL_TOOL)) stats.postToolControlExposures += 1
        streamText(res, { id, created, content: "V2_GOAL_COMMAND_DONE" })
        return
      }
      if (!names.includes(CONTROL_TOOL)) {
        res.writeHead(500, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: { message: `authorized /goal request did not expose ${CONTROL_TOOL}; tools=${JSON.stringify(names)}` } }))
        return
      }
      if (commandArgs === BUILD_ARGS) stats.buildAuthorizedRequests += 1
      else stats.planAuthorizedRequests += 1
      stats.controlToolCalls += 1
      streamToolCall(res, { id, created, argumentsText: commandArgs })
      return
    }

    if (text.includes(ORDINARY_TEXT) && names.includes(CONTROL_TOOL)) stats.ordinaryControlExposures += 1
    streamText(res, { id, created, content: text.includes(ORDINARY_TEXT) ? "ORDINARY_OK" : "CANARY_OK" })
  })

  return {
    stats,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", resolve)
      })
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("failed to start deterministic V2 behavior provider")
      return address.port
    },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

async function failureLog(env) {
  const candidates = [
    path.join(env.XDG_DATA_HOME, "opencode", "log", "opencode.log"),
    path.join(env.XDG_STATE_HOME, "opencode", "log", "opencode.log"),
  ]
  for (const file of candidates) {
    try {
      const raw = await readFile(file, "utf8")
      return raw.slice(-40_000)
    } catch {
      // Try the next location.
    }
  }
  return ""
}

async function apiPost(pathname, body, options) {
  const help = options.apiPostHelp
  const flag = /--data\b/.test(help) ? "--data" : /--body\b/.test(help) ? "--body" : null
  if (!flag) throw new Error(`Could not determine opencode2 api post JSON flag.\n${help}`)
  const result = await run("opencode2", ["api", "post", pathname, flag, JSON.stringify(body)], options)
  return parseJSONOutput(result, `POST ${pathname}`)
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
  await writeFile(path.join(pluginDirectory, "opencode-goals-v2-behavior.js"), `export { default } from ${JSON.stringify(pathToFileURL(pluginFile).href)}\n`)
  await writeFile(path.join(project, "README.md"), "# OpenCode 2 behavior canary\n")
  await writeFile(path.join(project, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "canary/canary",
    providers: {
      canary: {
        name: "Deterministic V2 Behavior Canary",
        package: "@opencode-ai/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${providerPort}/v1` },
        models: {
          canary: {
            modelID: "canary",
            name: "Deterministic V2 Behavior Canary",
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

  const options = { cwd: project, env, timeout: 90_000, apiPostHelp: "" }
  try {
    await run("git", ["init", "-q"], options)
    await run("git", ["config", "user.name", "OpenCode Goals Canary"], options)
    await run("git", ["config", "user.email", "opencode-goals-canary@example.invalid"], options)
    await run("git", ["add", "."], options)
    await run("git", ["commit", "-q", "-m", "initialize behavior canary workspace"], options)

    await run("opencode2", ["service", "stop"], { ...options, allowFailure: true, timeout: 15_000 })
    const version = output(await run("opencode2", ["--version"], { ...options, timeout: 30_000 }))
    if (!version) throw new Error("opencode2 --version returned no output")
    const postHelp = output(await run("opencode2", ["api", "post", "--help"], { ...options, allowFailure: true, timeout: 30_000 }))
    options.apiPostHelp = postHelp

    const locationQuery = `directory=${encodeURIComponent(project)}`
    const createSession = async (title) => {
      const response = await apiPost(`/session?${locationQuery}`, { title }, options)
      const value = response?.data ?? response
      const sessionID = String(value?.id ?? "")
      assert.ok(sessionID, `OpenCode 2 did not create a compatibility session: ${JSON.stringify(response)}`)
      return sessionID
    }

    const runGoal = async (sessionID, agent, args) => {
      return await apiPost(`/session/${encodeURIComponent(sessionID)}/command?${locationQuery}`, {
        sessionID,
        agent,
        model: "canary/canary",
        command: "goal",
        arguments: args,
      }, options)
    }

    const buildSessionID = await createSession("OpenCode Goals V2 behavior build")
    await runGoal(buildSessionID, "build", BUILD_ARGS)
    const buildGoal = await new GoalStore(project).load(buildSessionID)
    assert.ok(buildGoal, "real V2 /goal command did not persist Goal state")
    assert.equal(buildGoal.objective, "ship v2 behavior")
    assert.equal(buildGoal.status, "active")
    assert.equal(buildGoal.execution?.agent?.toLowerCase(), "build")
    assert.ok(buildGoal.requirements.some((item) => item.source === "acceptance" && item.text === "persisted on real host"))
    assert.ok(buildGoal.constraints?.includes("no stable claim"))
    assert.ok(buildGoal.requirements.some((item) => item.source === "check" && item.command === "echo ok"))

    await apiPost(`/session/${encodeURIComponent(buildSessionID)}/message?${locationQuery}`, {
      agent: "build",
      model: { providerID: "canary", modelID: "canary" },
      parts: [{ type: "text", text: ORDINARY_TEXT }],
    }, options)

    const planSessionID = await createSession("OpenCode Goals V2 behavior plan")
    await runGoal(planSessionID, "plan", PLAN_ARGS)
    const planGoal = await new GoalStore(project).load(planSessionID)
    assert.ok(planGoal, "real V2 Plan /goal command did not persist Goal state")
    assert.equal(planGoal.objective, "plan v2 boundary")
    assert.equal(planGoal.status, "paused")
    assert.equal(planGoal.execution?.agent?.toLowerCase(), "plan")
    assert.match(planGoal.stopReason ?? "", /Plan is a restricted execution agent/i)
    assert.ok(planGoal.requirements.some((item) => item.source === "acceptance" && item.text === "persisted paused"))

    assert.equal(provider.stats.buildAuthorizedRequests, 1, `build /goal should authorize control exactly once: ${JSON.stringify(provider.stats)}`)
    assert.equal(provider.stats.planAuthorizedRequests, 1, `Plan /goal should authorize control exactly once: ${JSON.stringify(provider.stats)}`)
    assert.equal(provider.stats.controlToolCalls, 2, `each real /goal command should execute exactly one control tool: ${JSON.stringify(provider.stats)}`)
    assert.equal(provider.stats.postToolControlExposures, 0, "same command turn must not re-expose control after its tool result")
    assert.equal(provider.stats.ordinaryControlExposures, 0, "ordinary requests must not expose the V2 control tool")
    assert.ok(provider.stats.getToolExposures >= 1, "V2 get tool was never exposed by the real host")

    console.log(JSON.stringify({
      ok: true,
      platform: process.platform,
      node: process.version,
      opencode2Version: version,
      buildSessionID,
      planSessionID,
      buildGoal: { objective: buildGoal.objective, status: buildGoal.status, agent: buildGoal.execution?.agent },
      planGoal: { objective: planGoal.objective, status: planGoal.status, agent: planGoal.execution?.agent, stopReason: planGoal.stopReason },
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
