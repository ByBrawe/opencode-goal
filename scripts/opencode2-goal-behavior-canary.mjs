import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { createServer } from "node:http"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const pluginID = "bybrawe.open-code-goals.v2-experimental"
const controlTool = "opencode_goals_v2_control"
const commandWrapper = "OpenCode Goals V2 command wrapper."
const ordinaryMarker = "ordinary V2 control exposure probe"
const readinessAttempts = 10
const readinessDelayMs = 500

function runSync(command, args, { cwd, env, allowFailure = false, timeout = 60_000 } = {}) {
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

async function runAsync(command, args, { cwd, env, timeout = 90_000 } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true })
    let stdout = ""
    let stderr = ""
    let settled = false
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
    child.stdout?.on("data", (chunk) => { stdout = (stdout + String(chunk)).slice(-8 * 1024 * 1024) })
    child.stderr?.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-8 * 1024 * 1024) })
    child.once("error", (error) => finish(reject, error))
    child.once("close", (code) => {
      if (code !== 0) {
        finish(reject, new Error(`command failed (${code}): ${command} ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
        return
      }
      finish(resolve, { stdout, stderr })
    })
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseJSONOutput(result, label) {
  const text = String(result.stdout ?? "").trim()
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

function contentText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((part) => typeof part?.text === "string" ? part.text : typeof part?.content === "string" ? part.content : "").join("\n")
}

function latestUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (String(messages[index]?.role ?? "").toLowerCase() !== "user") continue
    return contentText(messages[index]?.content)
  }
  return ""
}

function toolNames(body) {
  if (Array.isArray(body?.tools)) {
    return new Set(body.tools.map((item) => String(item?.function?.name ?? item?.name ?? "")).filter(Boolean))
  }
  if (body?.tools && typeof body.tools === "object") return new Set(Object.keys(body.tools))
  return new Set()
}

function priorControlCalls(body) {
  let count = 0
  for (const message of body?.messages ?? []) {
    for (const call of message?.tool_calls ?? []) {
      if (String(call?.function?.name ?? "") === controlTool) count += 1
    }
  }
  return count
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

function respondText(res, body, { id, created, content }) {
  if (body.stream) {
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
    return
  }
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

function respondToolCall(res, body, { id, created, callID, args }) {
  if (body.stream) {
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
          tool_calls: [{ index: 0, id: callID, type: "function", function: { name: controlTool, arguments: "" } }],
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
      usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
    })
    res.end("data: [DONE]\n\n")
    return
  }
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
        tool_calls: [{ id: callID, type: "function", function: { name: controlTool, arguments: JSON.stringify(args) } }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
  }))
}

function startProvider() {
  const stats = {
    requests: 0,
    completedGoalCommands: 0,
    goalFirstDispatches: 0,
    goalRedispatches: 0,
    ordinaryDispatches: 0,
    controlExposureViolations: 0,
    errors: [],
    observations: [],
  }
  let expectedArguments = null

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1")
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
      const id = `chatcmpl-v2-goal-${stats.requests}`
      const created = Math.floor(Date.now() / 1000)
      const latest = latestUserText(body)
      const tools = toolNames(body)
      const priorControls = priorControlCalls(body)
      const hasControl = tools.has(controlTool)
      stats.observations.push({ request: stats.requests, latest: latest.slice(0, 180), priorControls, hasControl })

      if (latest.includes(commandWrapper)) {
        if (priorControls === stats.completedGoalCommands) {
          if (!hasControl) {
            stats.controlExposureViolations += 1
            throw new Error(`fresh /goal dispatch did not expose ${controlTool}`)
          }
          if (typeof expectedArguments !== "string") throw new Error("provider received an unexpected fresh /goal dispatch")
          stats.goalFirstDispatches += 1
          respondToolCall(res, body, {
            id,
            created,
            callID: `call-v2-goal-${stats.completedGoalCommands + 1}`,
            args: { arguments: expectedArguments },
          })
          return
        }

        if (priorControls === stats.completedGoalCommands + 1) {
          if (hasControl) {
            stats.controlExposureViolations += 1
            throw new Error(`tool-result redispatch re-exposed ${controlTool}`)
          }
          stats.goalRedispatches += 1
          stats.completedGoalCommands += 1
          expectedArguments = null
          respondText(res, body, { id, created, content: "GOAL_COMMAND_DONE" })
          return
        }

        throw new Error(`unexpected control-call history: prior=${priorControls} completed=${stats.completedGoalCommands}`)
      }

      if (hasControl) {
        stats.controlExposureViolations += 1
        throw new Error(`ordinary model dispatch exposed ${controlTool}`)
      }
      if (latest.includes(ordinaryMarker)) stats.ordinaryDispatches += 1
      respondText(res, body, { id, created, content: "ORDINARY_OK" })
    } catch (error) {
      stats.errors.push(error instanceof Error ? error.message : String(error))
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: stats.errors.at(-1) } }))
    }
  })

  return {
    stats,
    expectGoal(argumentsText) {
      assert.equal(expectedArguments, null, "previous /goal command has not completed its redispatch")
      expectedArguments = argumentsText
    },
    assertGoalSettled() {
      assert.equal(expectedArguments, null, "expected /goal command did not complete its post-tool redispatch")
    },
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", resolve)
      })
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("failed to start V2 deterministic provider")
      return address.port
    },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

async function readGoal(project) {
  const goalDir = path.join(project, ".opencode", "goals")
  try {
    const files = (await readdir(goalDir)).filter((name) => name.endsWith(".json"))
    if (!files.length) return null
    assert.equal(files.length, 1, `expected exactly one Goal shard, found ${files.length}`)
    return JSON.parse(await readFile(path.join(goalDir, files[0]), "utf8"))
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

  await writeFile(
    path.join(pluginDirectory, "opencode-goals-v2-behavior.js"),
    `export { default } from ${JSON.stringify(pathToFileURL(pluginFile).href)}\n`,
  )
  await writeFile(path.join(project, "README.md"), "# OpenCode 2 Goal behavior canary\n")
  await writeFile(path.join(project, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "canary/canary",
    providers: {
      canary: {
        name: "Deterministic V2 Goal Canary",
        package: "@opencode-ai/ai/providers/openai-compatible",
        settings: {
          baseURL: `http://127.0.0.1:${providerPort}/v1`,
          apiKey: "canary-key",
        },
        models: {
          canary: {
            name: "Deterministic V2 Goal Canary",
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

  runSync("git", ["init", "-q"], { cwd: project, env })
  runSync("git", ["config", "user.name", "OpenCode Goals Canary"], { cwd: project, env })
  runSync("git", ["config", "user.email", "opencode-goals-canary@example.invalid"], { cwd: project, env })
  runSync("git", ["add", "."], { cwd: project, env })
  runSync("git", ["commit", "-q", "-m", "initialize behavior canary workspace"], { cwd: project, env })

  const location = `location%5Bdirectory%5D=${encodeURIComponent(project)}`
  const scoped = (pathname) => `${pathname}${pathname.includes("?") ? "&" : "?"}${location}`
  const api = async (method, pathname, dataValue, timeout = 90_000) => {
    const args = ["api", method, scoped(pathname)]
    if (dataValue !== undefined) args.push("--data", JSON.stringify(dataValue))
    const result = await runAsync("opencode2", args, { cwd: project, env, timeout })
    return parseJSONOutput(result, `${method.toUpperCase()} ${pathname}`)
  }

  try {
    runSync("opencode2", ["service", "stop"], { cwd: project, env, allowFailure: true, timeout: 15_000 })
    const version = String(runSync("opencode2", ["--version"], { cwd: project, env, timeout: 30_000 }).stdout ?? "").trim()
    assert.ok(version, "opencode2 --version returned no output")

    await api("get", "/api/health")

    let activeIDs = []
    const activation = []
    for (let attempt = 1; attempt <= readinessAttempts; attempt += 1) {
      const response = await api("get", "/api/plugin")
      if (response?._tag) throw new Error(`project-scoped /api/plugin rejected Location: ${JSON.stringify(response)}`)
      if (response?.location?.directory !== project) throw new Error(`wrong project Location: ${JSON.stringify(response?.location)}`)
      if (response?.location?.project?.id === "global") throw new Error("behavior canary workspace was classified as global")
      activeIDs = [...new Set(collectPluginIDs(response))]
      activation.push({ attempt, activeIDs })
      if (activeIDs.includes(pluginID)) break
      if (attempt < readinessAttempts) await sleep(readinessDelayMs)
    }
    assert.ok(activeIDs.includes(pluginID), `experimental V2 Goals adapter did not activate: ${JSON.stringify(activation)}`)

    const createdPayload = await api("post", "/api/session", { title: "OpenCode 2 Goal behavior canary" })
    const session = createdPayload?.data ?? createdPayload
    const sessionID = String(session?.id ?? "")
    assert.ok(sessionID, `OpenCode 2 did not create a session: ${JSON.stringify(createdPayload)}`)

    const sendGoal = async (argumentsText, agent = "build") => {
      provider.expectGoal(argumentsText)
      await api("post", `/api/session/${encodeURIComponent(sessionID)}/command`, {
        agent,
        command: "goal",
        arguments: argumentsText,
      }, 120_000)
      provider.assertGoalSettled()
    }

    await sendGoal("ship the V2 non-replay behavior canary")
    let goal = await readGoal(project)
    assert.ok(goal, "real /goal command did not persist Goal state")
    assert.equal(goal.sessionID, sessionID)
    assert.equal(goal.objective, "ship the V2 non-replay behavior canary")
    assert.equal(goal.status, "active")

    await api("post", `/api/session/${encodeURIComponent(sessionID)}/message`, {
      agent: "build",
      parts: [{ type: "text", text: ordinaryMarker }],
    }, 120_000)
    assert.equal(provider.stats.ordinaryDispatches, 1, "ordinary request was not observed by deterministic provider")

    await sendGoal("status")
    await sendGoal("status")
    await sendGoal("pause")
    goal = await readGoal(project)
    assert.equal(goal?.status, "paused", "/goal pause did not persist paused state")

    await sendGoal("resume", "plan")
    goal = await readGoal(project)
    assert.equal(goal?.status, "paused", "Plan must not activate a paused Goal")
    assert.match(String(goal?.stopReason ?? ""), /Plan|restricted execution agent/i)

    assert.equal(provider.stats.completedGoalCommands, 5, "expected five distinct real /goal command messages")
    assert.equal(provider.stats.goalFirstDispatches, 5, "each fresh /goal message must expose one control capability")
    assert.equal(provider.stats.goalRedispatches, 5, "each tool-result redispatch must be observed")
    assert.equal(provider.stats.controlExposureViolations, 0, "control capability leaked outside its one-shot command dispatch")
    assert.deepEqual(provider.stats.errors, [], `provider observed behavior errors: ${JSON.stringify(provider.stats.errors)}`)

    console.log(JSON.stringify({
      ok: true,
      platform: process.platform,
      node: process.version,
      opencode2Version: version,
      sessionID,
      pluginID,
      activation,
      completedGoalCommands: provider.stats.completedGoalCommands,
      goalFirstDispatches: provider.stats.goalFirstDispatches,
      goalRedispatches: provider.stats.goalRedispatches,
      ordinaryDispatches: provider.stats.ordinaryDispatches,
      controlExposureViolations: provider.stats.controlExposureViolations,
      finalGoalStatus: goal?.status,
      observations: provider.stats.observations,
    }, null, 2))
  } finally {
    runSync("opencode2", ["service", "stop"], { cwd: project, env, allowFailure: true, timeout: 15_000 })
    await provider.close()
    await rm(temp, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
