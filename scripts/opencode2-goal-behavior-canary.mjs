import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"
import { GoalStore } from "../dist/persistence/store.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const CONTROL_TOOL = "opencode_goals_v2_control"
const GET_TOOL = "opencode_goals_v2_get"
const EXACT_ARGUMENTS = 'real v2 goal behavior --success "exact args persist" --constraint "no unrelated mutation"'
const DECLARED_COMMAND_TEMPLATE = "UNTRANSFORMED_V2_GOAL_CANARY\\n$ARGUMENTS"
const COMMAND_WRAPPER_TEXT = "OpenCode Goals V2 command wrapper"

function appendLog(current, chunk, limit = 100_000) {
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

function parseJSONOutput(result, label) {
  const text = String(result.stdout ?? "").trim()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label} did not return JSON on stdout.\nstdout:\n${text}\nstderr:\n${String(result.stderr ?? "")}`)
  }
}

function contentText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((part) => {
    if (typeof part === "string") return part
    if (typeof part?.text === "string") return part.text
    if (typeof part?.content === "string") return part.content
    if (typeof part?.output === "string") return part.output
    return ""
  }).join("\n")
}

function allMessageText(body) {
  return (Array.isArray(body?.messages) ? body.messages : [])
    .map((message) => contentText(message?.content))
    .join("\n")
}

function toolNames(body) {
  const value = body?.tools
  if (Array.isArray(value)) {
    return value.map((item) => item?.function?.name ?? item?.name).filter((item) => typeof item === "string")
  }
  if (value && typeof value === "object") return Object.keys(value)
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
    usage: { prompt_tokens: 40, completion_tokens: 5, total_tokens: 45 },
  })
  res.end("data: [DONE]\n\n")
}

function streamToolCall(res, { id, created }) {
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
          id: "call-v2-goal-control",
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
          function: { arguments: JSON.stringify({ arguments: EXACT_ARGUMENTS }) },
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
    usage: { prompt_tokens: 48, completion_tokens: 12, total_tokens: 60 },
  })
  res.end("data: [DONE]\n\n")
}

function startProvider() {
  const stats = {
    chatRequests: 0,
    firstControlExposed: false,
    firstGetExposed: false,
    transformedWrapperSeen: false,
    exactArgumentsSeen: false,
    postToolControlExposed: false,
    paths: [],
    observations: [],
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
    const names = toolNames(body)
    const text = allMessageText(body)
    stats.chatRequests += 1
    const request = stats.chatRequests
    const hasControl = names.includes(CONTROL_TOOL)
    const hasGet = names.includes(GET_TOOL)
    const sawWrapper = text.includes(COMMAND_WRAPPER_TEXT)
    const sawExactArguments = text.includes(EXACT_ARGUMENTS)
    stats.observations.push({ request, tools: names, hasControl, hasGet, sawWrapper, sawExactArguments })

    const id = `chatcmpl-v2-goal-${request}`
    const created = Math.floor(Date.now() / 1000)
    if (request === 1) {
      stats.firstControlExposed = hasControl
      stats.firstGetExposed = hasGet
      stats.transformedWrapperSeen = sawWrapper
      stats.exactArgumentsSeen = sawExactArguments
      streamToolCall(res, { id, created })
      return
    }

    stats.postToolControlExposed ||= hasControl
    streamText(res, { id, created, content: "V2_GOAL_CONTROL_DONE" })
  })

  return {
    stats,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", resolve)
      })
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("failed to start V2 Goal behavior provider")
      return address.port
    },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

async function readFailureLog(env) {
  const candidates = [
    path.join(env.XDG_DATA_HOME, "opencode", "log", "opencode.log"),
    path.join(env.XDG_STATE_HOME, "opencode", "log", "opencode.log"),
  ]
  for (const file of candidates) {
    try {
      return (await readFile(file, "utf8")).slice(-50_000)
    } catch {
      // Try the next beta service log location.
    }
  }
  return ""
}

async function waitFor(predicate, description, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await predicate()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for ${description}`)
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
  const adapterBridge = path.join(pluginDirectory, "opencode-goals-v2-behavior.js")
  const provider = startProvider()
  const providerPort = await provider.listen()

  await Promise.all([
    mkdir(pluginDirectory, { recursive: true }),
    mkdir(config, { recursive: true }),
    mkdir(data, { recursive: true }),
    mkdir(state, { recursive: true }),
  ])

  await writeFile(adapterBridge, `export { default } from ${JSON.stringify(pathToFileURL(pluginFile).href)}\n`)
  await writeFile(path.join(project, "README.md"), "# OpenCode 2 Goal behavior canary\n")
  await writeFile(path.join(project, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "canary/canary",
    provider: {
      canary: {
        npm: "@ai-sdk/openai-compatible",
        name: "Deterministic V2 Goal Behavior Canary",
        options: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "canary-key" },
        models: { canary: { name: "Deterministic V2 Goal Behavior Canary", limit: { context: 100000, output: 4096 } } },
      },
    },
    command: {
      goal: {
        template: DECLARED_COMMAND_TEMPLATE,
        description: "Declared Goal command for the OpenCode 2 behavior canary",
        agent: "build",
        subtask: false,
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
  await run("git", ["commit", "-q", "-m", "initialize V2 behavior workspace"], { cwd: project, env })

  const locationQuery = `location%5Bdirectory%5D=${encodeURIComponent(project)}`
  const scoped = (pathname) => `${pathname}${pathname.includes("?") ? "&" : "?"}${locationQuery}`
  const api = async (method, pathname, dataValue) => {
    const args = ["api", method.toLowerCase(), scoped(pathname)]
    if (dataValue !== undefined) args.push("--data", JSON.stringify(dataValue))
    const result = await run("opencode2", args, { cwd: project, env, timeout: 90_000 })
    const text = String(result.stdout ?? "").trim()
    if (!text) return null
    return parseJSONOutput(result, `${method.toUpperCase()} ${pathname}`)
  }

  try {
    await run("opencode2", ["service", "stop"], { cwd: project, env, allowFailure: true, timeout: 20_000 })
    const version = String((await run("opencode2", ["--version"], { cwd: project, env, timeout: 30_000 })).stdout ?? "").trim()
    assert.ok(version, "opencode2 --version returned no output")

    const health = await api("get", "/api/health")
    assert.ok(health, "OpenCode 2 health API returned no payload")

    const commandCatalog = await waitFor(async () => {
      const response = await api("get", "/api/command")
      const items = response?.data ?? response
      if (!Array.isArray(items)) return null
      const goal = items.find((item) => item?.name === "goal" || item?.id === "goal")
      return goal ?? null
    }, "declared goal command to enter the beta command catalog")
    assert.notEqual(commandCatalog?.template, DECLARED_COMMAND_TEMPLATE, "V2 command.transform did not replace the declared goal template")

    const createdPayload = await api("post", "/api/session", {
      title: "OpenCode Goals V2 current-beta behavior",
      agent: "build",
      model: { id: "canary", providerID: "canary" },
    })
    const session = createdPayload?.data ?? createdPayload
    const sessionID = String(session?.id ?? "")
    assert.ok(sessionID, `OpenCode 2 did not create a session: ${JSON.stringify(createdPayload)}`)
    const sessionDirectory = session?.location?.directory ?? session?.directory
    if (sessionDirectory) assert.equal(path.resolve(sessionDirectory), path.resolve(project))

    const commandPromise = api("post", `/api/session/${encodeURIComponent(sessionID)}/command`, {
      command: "goal",
      arguments: EXACT_ARGUMENTS,
      agent: "build",
      model: "canary/canary",
    })

    const store = new GoalStore(project)
    const goal = await waitFor(async () => {
      const current = await store.load(sessionID)
      return current?.objective === "real v2 goal behavior" ? current : null
    }, "exact /goal control to persist its Goal", 30_000)

    await commandPromise
    await waitFor(() => provider.stats.chatRequests >= 2 ? true : null, "post-tool provider request", 10_000)

    assert.equal(provider.stats.firstControlExposed, true, "authorized real /goal request did not expose the request-scoped control tool")
    assert.equal(provider.stats.firstGetExposed, true, "registered V2 read tool was absent from the real provider request")
    assert.equal(provider.stats.transformedWrapperSeen, true, "real command.transform path did not deliver the V2 command wrapper")
    assert.equal(provider.stats.exactArgumentsSeen, true, "real command transport did not preserve the exact raw /goal arguments")
    assert.equal(goal.objective, "real v2 goal behavior")
    assert.deepEqual(goal.constraints, ["no unrelated mutation"])
    assert.equal(provider.stats.postToolControlExposed, false, `consumed V2 control capability was re-exposed after the tool call: ${JSON.stringify(provider.stats.observations)}`)

    console.log(JSON.stringify({
      ok: true,
      platform: process.platform,
      node: process.version,
      opencode2Version: version,
      sessionID,
      goalID: goal.id,
      commandCatalog: {
        name: commandCatalog?.name ?? commandCatalog?.id ?? "goal",
        transformed: commandCatalog?.template !== DECLARED_COMMAND_TEMPLATE,
      },
      provider: provider.stats,
    }, null, 2))
  } catch (error) {
    const logTail = await readFailureLog(env)
    if (logTail) console.error(`OpenCode 2 server log tail:\n${logTail}`)
    console.error(`V2 behavior provider observations:\n${JSON.stringify(provider.stats, null, 2)}`)
    throw error
  } finally {
    await run("opencode2", ["service", "stop"], { cwd: project, env, allowFailure: true, timeout: 20_000 }).catch(() => undefined)
    await provider.close().catch(() => undefined)
    await rm(temp, { recursive: true, force: true }).catch(() => undefined)
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
