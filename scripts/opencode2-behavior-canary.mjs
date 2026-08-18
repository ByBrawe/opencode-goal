import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { createServer } from "node:http"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const CONTROL_TOOL = "opencode_goals_v2_control"
const PLUGIN_ID = "bybrawe.open-code-goals.v2-experimental"
const COMMAND_PREAMBLE = "OpenCode Goals V2 command wrapper."
const OBJECTIVE = "real OpenCode 2 behavior canary"
const ORDINARY_PROMPT = "ordinary OpenCode 2 request after Goal control"
const PLAN_OBJECTIVE = "real OpenCode 2 plan boundary canary"
const MODEL = { providerID: "canary", id: "canary" }
const READINESS_ATTEMPTS = 20
const READINESS_DELAY_MS = 500

function appendLog(current, chunk, limit = 80_000) {
  return (current + String(chunk)).slice(-limit)
}

function runSync(command, args, { cwd, env, allowFailure = false, timeout = 30_000 } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout,
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (!allowFailure && result.status !== 0) {
    throw new Error(`command failed (${result.status}): ${command} ${args.join(" ")}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`)
  }
  return result
}

async function run(command, args, { cwd, env, allowFailure = false, timeout = 60_000 } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true })
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
      if (!allowFailure && code !== 0) {
        finish(reject, new Error(`command failed (${code}): ${command} ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
        return
      }
      finish(resolve, { status: code, stdout, stderr })
    })
  })
}

function parseJSON(result, label) {
  const text = String(result.stdout ?? "").trim()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label} did not return JSON.\nstdout:\n${text}\nstderr:\n${String(result.stderr ?? "")}`)
  }
}

function collectPluginIDs(value) {
  if (Array.isArray(value)) return value.flatMap(collectPluginIDs)
  if (typeof value === "string") return [value]
  if (!value || typeof value !== "object") return []
  const direct = [value.id, value.pluginID, value.name].filter((item) => typeof item === "string")
  const nested = [value.data, value.plugins, value.items].flatMap((item) => collectPluginIDs(item))
  return [...direct, ...nested]
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
  return content.map((part) => typeof part?.text === "string" ? part.text : typeof part?.content === "string" ? part.content : "").join("\n")
}

function latestUserIndex(body) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (String(messages[index]?.role ?? "").toLowerCase() === "user") return index
  }
  return -1
}

function latestUserText(body) {
  const index = latestUserIndex(body)
  return index >= 0 ? contentText(body.messages[index]?.content) : ""
}

function toolCallNamesAfterLatestUser(body) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const start = latestUserIndex(body) + 1
  const names = []
  for (const message of messages.slice(Math.max(0, start))) {
    for (const call of message?.tool_calls ?? []) {
      const name = String(call?.function?.name ?? call?.name ?? "")
      if (name) names.push(name)
    }
    for (const part of Array.isArray(message?.content) ? message.content : []) {
      const name = String(part?.toolName ?? part?.tool_name ?? part?.name ?? "")
      if (["tool-call", "tool_call", "tool-use", "tool_use"].includes(String(part?.type ?? "")) && name) names.push(name)
    }
  }
  return names
}

function rawGoalArguments(text) {
  if (!text.includes(COMMAND_PREAMBLE)) return undefined
  const marker = text.match(/__OPENCODE_GOALS_V2_COMMAND_[0-9a-f-]+__/i)?.[0]
  if (!marker) return undefined
  const prefix = `${marker}\n`
  const index = text.indexOf(prefix)
  return index >= 0 ? text.slice(index + prefix.length) : undefined
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
    usage: { prompt_tokens: 40, completion_tokens: 3, total_tokens: 43 },
  })
  res.end("data: [DONE]\n\n")
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
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }, finish_reason: null }],
  })
  writeSse(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model: "canary",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 48, completion_tokens: 12, total_tokens: 60 },
  })
  res.end("data: [DONE]\n\n")
}

function startProvider() {
  const stats = {
    chatRequests: 0,
    paths: [],
    commandInitialWithControl: 0,
    commandFollowupWithoutControl: 0,
    ordinaryWithoutControl: 0,
    statusInitialWithControl: 0,
    planInitialWithControl: 0,
    failure: "",
  }

  const server = createServer(async (req, res) => {
    try {
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
      const id = `chatcmpl-opencode2-behavior-${stats.chatRequests}`
      const created = Math.floor(Date.now() / 1000)
      const tools = toolNames(body)
      const userText = latestUserText(body)
      const goalArgs = rawGoalArguments(userText)
      const controlUsed = toolCallNamesAfterLatestUser(body).includes(CONTROL_TOOL)

      if (goalArgs !== undefined) {
        if (controlUsed) {
          assert.equal(tools.has(CONTROL_TOOL), false, "single-use V2 control was re-exposed after it already ran in the same command turn")
          stats.commandFollowupWithoutControl += 1
          streamText(res, { id, created, content: "Goal control completed." })
          return
        }

        assert.equal(tools.has(CONTROL_TOOL), true, "authorized /goal command request did not expose the V2 control tool")
        if (goalArgs === "status") stats.statusInitialWithControl += 1
        else if (goalArgs.startsWith(PLAN_OBJECTIVE)) stats.planInitialWithControl += 1
        else stats.commandInitialWithControl += 1
        streamToolCall(res, {
          id,
          created,
          callID: `call-v2-control-${stats.chatRequests}`,
          name: CONTROL_TOOL,
          args: { arguments: goalArgs },
        })
        return
      }

      if (userText.includes(ORDINARY_PROMPT)) {
        assert.equal(tools.has(CONTROL_TOOL), false, "ordinary V2 request exposed the Goal control capability")
        stats.ordinaryWithoutControl += 1
        streamText(res, { id, created, content: "Ordinary request completed without Goal control." })
        return
      }

      streamText(res, { id, created, content: "CANARY_OK" })
    } catch (error) {
      stats.failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" })
      if (!res.writableEnded) res.end(JSON.stringify({ error: { message: stats.failure } }))
    }
  })

  return {
    stats,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", resolve)
      })
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("failed to start OpenCode 2 deterministic provider")
      return address.port
    },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

async function readGoal(project, sessionID) {
  const dir = path.join(project, ".opencode", "goals")
  try {
    const files = (await readdir(dir)).filter((name) => name.endsWith(".json"))
    for (const name of files) {
      const value = JSON.parse(await readFile(path.join(dir, name), "utf8"))
      if (value?.sessionID === sessionID) return value
    }
    return null
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
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
  await writeFile(path.join(project, "README.md"), "# OpenCode 2 Goal behavior canary\n")
  await writeFile(path.join(project, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "canary/canary",
    providers: {
      canary: {
        name: "OpenCode 2 deterministic Goal canary",
        package: "aisdk:@ai-sdk/openai-compatible",
        settings: {
          baseURL: `http://127.0.0.1:${providerPort}/v1`,
          apiKey: "canary-key",
        },
        models: {
          canary: {
            name: "OpenCode 2 deterministic Goal canary",
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            limit: { context: 65536, output: 4096 },
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
    XDG_CACHE_HOME: path.join(home, ".cache"),
    OPENCODE_DB: path.join(data, "opencode", "opencode-v2-behavior.db"),
    OPENCODE_LOG_LEVEL: "DEBUG",
    CI: "true",
  }

  runSync("git", ["init", "-q"], { cwd: project, env })
  runSync("git", ["config", "user.name", "OpenCode Goals V2 Behavior Canary"], { cwd: project, env })
  runSync("git", ["config", "user.email", "opencode-goals-v2-canary@example.invalid"], { cwd: project, env })
  runSync("git", ["add", "."], { cwd: project, env })
  runSync("git", ["commit", "-q", "-m", "initialize V2 behavior canary"], { cwd: project, env })

  const location = `location%5Bdirectory%5D=${encodeURIComponent(project)}`
  const apiPath = (pathname) => `${pathname}${pathname.includes("?") ? "&" : "?"}${location}`
  const api = async (method, pathname, body, timeout = 60_000) => {
    const args = ["api", method.toLowerCase(), apiPath(pathname)]
    if (body !== undefined) args.push("--data", JSON.stringify(body))
    const result = await run("opencode2", args, { cwd: project, env, timeout })
    return parseJSON(result, `${method} ${pathname}`)
  }

  const waitForPlugin = async () => {
    let lastIDs = []
    for (let attempt = 1; attempt <= READINESS_ATTEMPTS; attempt += 1) {
      const response = await api("GET", "/api/plugin")
      lastIDs = [...new Set(collectPluginIDs(response))]
      if (lastIDs.includes(PLUGIN_ID)) return attempt
      if (attempt < READINESS_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, READINESS_DELAY_MS))
    }
    throw new Error(`experimental V2 Goals plugin did not become ready after ${READINESS_ATTEMPTS} probes: ${JSON.stringify(lastIDs)}`)
  }

  try {
    runSync("opencode2", ["service", "stop"], { cwd: project, env, allowFailure: true, timeout: 15_000 })
    await api("GET", "/api/health")
    const pluginReadyAttempt = await waitForPlugin()

    const createSession = async (title, agent = "build") => {
      const payload = await api("POST", "/api/session", {
        title,
        agent,
        model: MODEL,
        location: { directory: project },
      })
      const session = payload?.data ?? payload
      assert.ok(session?.id, `OpenCode 2 did not create a session: ${JSON.stringify(payload)}`)
      return String(session.id)
    }

    const waitForIdle = async (sessionID) => {
      await api("POST", `/api/session/${encodeURIComponent(sessionID)}/wait`, undefined, 90_000)
    }

    const runCommand = async (sessionID, argumentsText, agent = "build") => {
      await api("POST", `/api/session/${encodeURIComponent(sessionID)}/command`, {
        agent,
        model: MODEL,
        command: "goal",
        arguments: argumentsText,
        resume: true,
      }, 90_000)
      await waitForIdle(sessionID)
    }

    const runPrompt = async (sessionID, text, agent = "build") => {
      await api("POST", `/api/session/${encodeURIComponent(sessionID)}/prompt`, {
        text,
        agent,
        model: MODEL,
        resume: true,
      }, 90_000)
      await waitForIdle(sessionID)
    }

    const sessionID = await createSession("OpenCode 2 Goal behavior canary")
    const rawCreate = `${OBJECTIVE} --success "state persists" --constraint "stay experimental" --check "node -e \\"process.exit(0)\\""`
    await runCommand(sessionID, rawCreate)

    const created = await readGoal(project, sessionID)
    assert.ok(created, "real OpenCode 2 /goal command did not persist Goal state")
    assert.equal(created.objective, OBJECTIVE)
    assert.equal(created.status, "active")
    assert.ok(created.constraints.includes("stay experimental"))
    assert.ok(created.requirements.some((item) => item.source === "acceptance" && item.text === "state persists"))
    assert.ok(created.requirements.some((item) => item.source === "check" && item.command === "node -e \\"process.exit(0)\\""))

    await runPrompt(sessionID, ORDINARY_PROMPT)
    await runCommand(sessionID, "status")
    const afterStatus = await readGoal(project, sessionID)
    assert.deepEqual(afterStatus, created, "read-only /goal status changed persisted Goal state")

    const planSessionID = await createSession("OpenCode 2 Plan boundary canary", "plan")
    await runCommand(planSessionID, `${PLAN_OBJECTIVE} --constraint "plan must stay paused"`, "plan")
    const planned = await readGoal(project, planSessionID)
    assert.ok(planned, "Plan /goal command did not persist Goal state")
    assert.equal(planned.objective, PLAN_OBJECTIVE)
    assert.equal(planned.status, "paused")
    assert.match(planned.stopReason ?? "", /Plan is a restricted execution agent/i)

    assert.equal(provider.stats.failure, "", `deterministic provider assertion failed: ${provider.stats.failure}`)
    assert.equal(provider.stats.commandInitialWithControl, 1, "expected one authorized create command request")
    assert.ok(provider.stats.commandFollowupWithoutControl >= 3, "each real control call should be followed by a provider step without control capability")
    assert.equal(provider.stats.ordinaryWithoutControl, 1, "ordinary request did not prove control removal")
    assert.equal(provider.stats.statusInitialWithControl, 1, "a new /goal status command did not regain an authorized capability")
    assert.equal(provider.stats.planInitialWithControl, 1, "Plan command did not exercise the authorized control path")

    console.log(JSON.stringify({
      ok: true,
      platform: process.platform,
      node: process.version,
      pluginReadyAttempt,
      sessionID,
      planSessionID,
      goalStatus: created.status,
      planGoalStatus: planned.status,
      provider: provider.stats,
    }, null, 2))
  } finally {
    runSync("opencode2", ["service", "stop"], { cwd: project, env, allowFailure: true, timeout: 15_000 })
    await provider.close().catch(() => undefined)
    await rm(temp, { recursive: true, force: true }).catch(() => undefined)
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
