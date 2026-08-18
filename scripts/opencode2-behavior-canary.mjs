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
const GET_TOOL = "opencode_goals_v2_get"
const RAW_ARGUMENTS = 'prove v2 host behavior --success "v2 behavior persisted" --constraint "stable v1 untouched"'
const ORDINARY_FOLLOWUP = "ordinary follow-up must not expose the V2 lifecycle control"
const EXPECTED_OBJECTIVE = "prove v2 host behavior"
const EXPECTED_SUCCESS = "v2 behavior persisted"
const EXPECTED_CONSTRAINT = "stable v1 untouched"

function appendLog(current, chunk, limit = 80_000) {
  return (current + String(chunk)).slice(-limit)
}

function runSync(command, args, { cwd, env, allowFailure = false, timeout = 30_000 } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true })
  if (result.error) throw result.error
  if (!allowFailure && result.status !== 0) {
    throw new Error(`command failed (${result.status}): ${command} ${args.join(" ")}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`)
  }
  return result
}

async function run(command, args, { cwd, env, timeoutMs = 90_000 } = {}) {
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
    }, timeoutMs)
    child.once("error", (error) => finish(reject, error))
    child.once("close", (code) => {
      if (code !== 0) {
        finish(reject, new Error(`command exited ${code}: ${command} ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
        return
      }
      finish(resolve, { stdout, stderr })
    })
  })
}

function contentText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((part) => {
    if (typeof part?.text === "string") return part.text
    if (typeof part?.content === "string") return part.content
    if (typeof part?.output === "string") return part.output
    if (part?.output && typeof part.output === "object") return JSON.stringify(part.output)
    return ""
  }).join("\n")
}

function allMessageText(body) {
  return (body.messages ?? []).map((message) => contentText(message?.content)).join("\n")
}

function toolNames(body) {
  if (Array.isArray(body?.tools)) {
    return body.tools.map((item) => item?.function?.name ?? item?.name).filter((item) => typeof item === "string")
  }
  if (body?.tools && typeof body.tools === "object") return Object.keys(body.tools)
  return []
}

function hasTool(body, name) {
  return toolNames(body).includes(name)
}

function hasToolResult(body, name) {
  return (body.messages ?? []).some((message) => {
    if (message?.role !== "tool") return false
    if (message?.name === name || message?.toolName === name) return true
    return contentText(message?.content).includes("OpenCode Goals contract")
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
    usage: { prompt_tokens: 48, completion_tokens: 4, total_tokens: 52 },
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
    usage: { prompt_tokens: 64, completion_tokens: 12, total_tokens: 76 },
  })
  res.end("data: [DONE]\n\n")
}

function startProvider() {
  const stats = {
    chatRequests: 0,
    commandRequests: 0,
    postToolRequests: 0,
    ordinaryRequests: 0,
    transformedCommandSeen: false,
    initialControlExposed: false,
    postToolControlExposed: false,
    ordinaryControlExposed: false,
    getToolSeen: false,
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
    const id = `chatcmpl-opencode2-behavior-${stats.chatRequests}`
    const created = Math.floor(Date.now() / 1000)
    const text = allMessageText(body)
    stats.getToolSeen ||= hasTool(body, GET_TOOL)

    if (text.includes(ORDINARY_FOLLOWUP)) {
      stats.ordinaryRequests += 1
      stats.ordinaryControlExposed ||= hasTool(body, CONTROL_TOOL)
      streamText(res, { id, created, content: "ORDINARY_DONE" })
      return
    }

    if (hasToolResult(body, CONTROL_TOOL)) {
      stats.postToolRequests += 1
      stats.postToolControlExposed ||= hasTool(body, CONTROL_TOOL)
      streamText(res, { id, created, content: "COMMAND_DONE" })
      return
    }

    if (text.includes(RAW_ARGUMENTS)) {
      stats.commandRequests += 1
      stats.transformedCommandSeen ||= /OpenCode Goals V2 command wrapper/.test(text)
        && /__OPENCODE_GOALS_V2_COMMAND_[0-9a-f-]+__/i.test(text)
      stats.initialControlExposed ||= hasTool(body, CONTROL_TOOL)
      if (!hasTool(body, CONTROL_TOOL)) {
        streamText(res, { id, created, content: "MISSING_CONTROL" })
        return
      }
      streamToolCall(res, {
        id,
        created,
        callID: "call-opencode2-goal-control",
        name: CONTROL_TOOL,
        args: { arguments: RAW_ARGUMENTS },
      })
      return
    }

    // Title/small-model or other host-internal requests are intentionally benign.
    streamText(res, { id, created, content: "CANARY_OK" })
  })

  return {
    stats,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", resolve)
      })
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("failed to start OpenCode 2 behavior provider")
      return address.port
    },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

async function readGoal(project) {
  const dir = path.join(project, ".opencode", "goals")
  const files = (await readdir(dir)).filter((name) => name.endsWith(".json"))
  assert.equal(files.length, 1, `expected exactly one persisted Goal shard, found ${files.length}`)
  return JSON.parse(await readFile(path.join(dir, files[0]), "utf8"))
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
  let commandResult = null
  let ordinaryResult = null

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
    plugins: ["./.opencode/plugins/opencode-goals-v2-behavior.js"],
    model: "canary/canary",
    providers: {
      canary: {
        name: "Deterministic OpenCode 2 Behavior Canary",
        package: "aisdk:@ai-sdk/openai-compatible",
        settings: {
          baseURL: `http://127.0.0.1:${providerPort}/v1`,
          apiKey: "canary-key",
        },
        models: {
          canary: {
            modelID: "canary",
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

  runSync("git", ["init", "-q"], { cwd: project, env })
  runSync("git", ["config", "user.name", "OpenCode Goals Canary"], { cwd: project, env })
  runSync("git", ["config", "user.email", "opencode-goals-canary@example.invalid"], { cwd: project, env })
  runSync("git", ["add", "."], { cwd: project, env })
  runSync("git", ["commit", "-q", "-m", "initialize V2 behavior canary"], { cwd: project, env })

  const diagnostics = () => [
    `provider=${JSON.stringify(provider.stats, null, 2)}`,
    `command stdout=${String(commandResult?.stdout ?? "")}`,
    `command stderr=${String(commandResult?.stderr ?? "")}`,
    `ordinary stdout=${String(ordinaryResult?.stdout ?? "")}`,
    `ordinary stderr=${String(ordinaryResult?.stderr ?? "")}`,
  ].join("\n")

  try {
    commandResult = await run("opencode2", [
      "run",
      "--format", "json",
      "--model", "canary/canary",
      "--agent", "build",
      "--command", "goal",
      RAW_ARGUMENTS,
    ], { cwd: project, env, timeoutMs: 120_000 })

    const goal = await readGoal(project)
    assert.equal(goal.objective, EXPECTED_OBJECTIVE, diagnostics())
    assert.equal(goal.status, "active", diagnostics())
    assert.equal(goal.execution?.agent, "build", diagnostics())
    assert.ok(goal.constraints?.includes(EXPECTED_CONSTRAINT), diagnostics())
    assert.ok(goal.requirements?.some((item) => item.source === "acceptance" && item.text === EXPECTED_SUCCESS), diagnostics())
    assert.ok(goal.sessionID, `persisted Goal has no sessionID\n${diagnostics()}`)

    ordinaryResult = await run("opencode2", [
      "run",
      "--format", "json",
      "--session", goal.sessionID,
      "--model", "canary/canary",
      "--agent", "build",
      ORDINARY_FOLLOWUP,
    ], { cwd: project, env, timeoutMs: 120_000 })

    assert.ok(provider.stats.commandRequests >= 1, `provider never saw the transformed /goal command\n${diagnostics()}`)
    assert.equal(provider.stats.transformedCommandSeen, true, `command.transform did not preserve the V2 capability wrapper and exact arguments\n${diagnostics()}`)
    assert.equal(provider.stats.initialControlExposed, true, `authorized /goal request did not expose ${CONTROL_TOOL}\n${diagnostics()}`)
    assert.ok(provider.stats.postToolRequests >= 1, `real tool result never produced a follow-up model request\n${diagnostics()}`)
    assert.equal(provider.stats.postToolControlExposed, false, `single-use control was re-exposed after its tool result\n${diagnostics()}`)
    assert.ok(provider.stats.ordinaryRequests >= 1, `ordinary follow-up never reached the provider\n${diagnostics()}`)
    assert.equal(provider.stats.ordinaryControlExposed, false, `ordinary request exposed ${CONTROL_TOOL}\n${diagnostics()}`)
    assert.equal(provider.stats.getToolSeen, true, `read-only ${GET_TOOL} was not available to the real host\n${diagnostics()}`)

    console.log(JSON.stringify({
      ok: true,
      platform: process.platform,
      sessionID: goal.sessionID,
      objective: goal.objective,
      commandRequests: provider.stats.commandRequests,
      postToolRequests: provider.stats.postToolRequests,
      ordinaryRequests: provider.stats.ordinaryRequests,
      transformedCommandSeen: provider.stats.transformedCommandSeen,
      initialControlExposed: provider.stats.initialControlExposed,
      postToolControlExposed: provider.stats.postToolControlExposed,
      ordinaryControlExposed: provider.stats.ordinaryControlExposed,
      getToolSeen: provider.stats.getToolSeen,
    }, null, 2))
  } finally {
    await provider.close().catch(() => undefined)
    await rm(temp, { recursive: true, force: true }).catch(() => undefined)
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
