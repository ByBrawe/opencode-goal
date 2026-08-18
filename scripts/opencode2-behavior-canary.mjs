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
const CREATE_ARGUMENTS = 'ship real v2 host --success "real command path persists"'
const COMMAND_PREAMBLE = "OpenCode Goals V2 command wrapper."

function appendLog(current, chunk, limit = 80_000) {
  return (current + String(chunk)).slice(-limit)
}

function contentText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => typeof part?.text === "string" ? part.text : typeof part?.content === "string" ? part.content : "")
    .join("\n")
}

function allMessageText(body) {
  return (body.messages ?? []).map((message) => contentText(message?.content)).join("\n")
}

function toolNames(body) {
  return (body.tools ?? [])
    .map((item) => item?.function?.name ?? item?.name)
    .filter((item) => typeof item === "string")
}

function toolDefinition(body, name) {
  return (body.tools ?? []).find((item) => (item?.function?.name ?? item?.name) === name)
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
    requests: [],
    phase: "command",
    error: null,
  }

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
      const names = toolNames(body)
      const text = allMessageText(body)
      const control = Boolean(toolDefinition(body, CONTROL_TOOL))
      const request = {
        index: stats.requests.length + 1,
        phase: stats.phase,
        control,
        toolNames: names,
        commandWrapper: text.includes(COMMAND_PREAMBLE),
        exactArgumentsVisible: text.includes(CREATE_ARGUMENTS),
      }
      stats.requests.push(request)

      const id = `chatcmpl-v2-behavior-${request.index}`
      const created = Math.floor(Date.now() / 1000)

      if (stats.phase === "command") {
        assert.ok(request.commandWrapper, "real /goal command did not reach the model through the transformed command template")
        assert.ok(request.exactArgumentsVisible, "real /goal command did not preserve the exact raw arguments in the transformed command template")
        assert.ok(control, "authorized real /goal command request did not expose the V2 control tool")
        stats.phase = "command-result"
        streamToolCall(res, {
          id,
          created,
          callID: "call-v2-real-control",
          name: CONTROL_TOOL,
          args: { arguments: CREATE_ARGUMENTS },
        })
        return
      }

      if (stats.phase === "command-result") {
        assert.equal(control, false, "single-use V2 control tool was re-exposed after it had already executed in the same /goal command turn")
        stats.phase = "ordinary"
        streamText(res, { id, created, content: "V2_GOAL_COMMAND_DONE" })
        return
      }

      if (stats.phase === "ordinary") {
        assert.equal(control, false, "ordinary request exposed the V2 control tool without an authorized /goal command")
        stats.phase = "done"
        streamText(res, { id, created, content: "V2_ORDINARY_DONE" })
        return
      }

      streamText(res, { id, created, content: "V2_CANARY_UNEXPECTED_EXTRA_REQUEST" })
    } catch (error) {
      stats.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      res.writeHead(500, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: stats.error } }))
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
      if (!address || typeof address === "string") throw new Error("failed to start deterministic V2 provider")
      return address.port
    },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

async function stopProcess(child, timeoutMs = 2_000) {
  if (!child || child.exitCode !== null) return
  child.kill()
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve()
    const timer = setTimeout(resolve, timeoutMs)
    child.once("close", () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function run(command, args, { cwd, env, timeoutMs = 90_000, allowFailure = false } = {}) {
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
      void stopProcess(child)
      finish(reject, new Error(`command timed out: ${command} ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, timeoutMs)
    child.once("error", (error) => finish(reject, error))
    child.once("close", (code) => {
      const result = { code, stdout, stderr }
      if (!allowFailure && code !== 0) {
        finish(reject, new Error(`command failed (${code}): ${command} ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
        return
      }
      finish(resolve, result)
    })
  })
}

async function readOnlyGoal(project) {
  const directory = path.join(project, ".opencode", "goals")
  const files = (await readdir(directory)).filter((name) => name.endsWith(".json"))
  assert.equal(files.length, 1, `expected exactly one V2 Goal state shard, found ${files.length}`)
  return JSON.parse(await readFile(path.join(directory, files[0]), "utf8"))
}

async function main() {
  const provider = startProvider()
  const providerPort = await provider.listen()
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-v2-behavior-"))
  const project = path.join(temp, "project")
  const home = path.join(temp, "home")
  const config = path.join(home, ".config")
  const data = path.join(home, ".local", "share")
  const state = path.join(home, ".local", "state")
  const pluginDirectory = path.join(project, ".opencode", "plugins")
  const pluginFile = path.join(root, "dist", "opencode2", "experimental.js")

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
  await writeFile(path.join(project, "README.md"), "# OpenCode 2 behavioral host canary\n")
  await writeFile(path.join(project, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "canary/canary",
    providers: {
      canary: {
        name: "Deterministic V2 Canary",
        api: {
          type: "aisdk",
          package: "@ai-sdk/openai-compatible",
          url: `http://127.0.0.1:${providerPort}/v1`,
        },
        request: {
          body: { apiKey: "canary-key" },
        },
        models: {
          canary: {
            name: "Deterministic V2 Canary",
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
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    CI: "true",
  }

  let commandResult = null
  let ordinaryResult = null
  try {
    await run("git", ["init", "-q"], { cwd: project, env, timeoutMs: 30_000 })
    await run("git", ["config", "user.name", "OpenCode Goals Canary"], { cwd: project, env, timeoutMs: 30_000 })
    await run("git", ["config", "user.email", "opencode-goals-canary@example.invalid"], { cwd: project, env, timeoutMs: 30_000 })
    await run("git", ["add", "."], { cwd: project, env, timeoutMs: 30_000 })
    await run("git", ["commit", "-q", "-m", "initialize V2 behavior workspace"], { cwd: project, env, timeoutMs: 30_000 })

    await run("opencode2", ["service", "stop"], { cwd: project, env, allowFailure: true, timeoutMs: 15_000 })
    const version = await run("opencode2", ["--version"], { cwd: project, env, timeoutMs: 30_000 })

    commandResult = await run("opencode2", [
      "run",
      "--command", "goal",
      "--agent", "build",
      "--model", "canary/canary",
      CREATE_ARGUMENTS,
    ], { cwd: project, env, timeoutMs: 90_000 })

    if (provider.stats.error) throw new Error(`deterministic provider assertion failed: ${provider.stats.error}`)
    assert.equal(provider.stats.phase, "ordinary", `real /goal command did not complete the expected provider cycle: ${JSON.stringify(provider.stats)}`)

    const goal = await readOnlyGoal(project)
    assert.equal(goal.objective, "ship real v2 host")
    assert.equal(goal.status, "active")
    assert.ok(goal.requirements.some((item) => item.source === "acceptance" && item.text === "real command path persists"))
    assert.equal(goal.execution?.agent?.toLowerCase(), "build")
    const sessionID = String(goal.sessionID ?? "")
    assert.ok(sessionID, "persisted V2 Goal did not record its real host sessionID")

    ordinaryResult = await run("opencode2", [
      "run",
      "--session", sessionID,
      "--agent", "build",
      "--model", "canary/canary",
      "ordinary follow-up after goal command",
    ], { cwd: project, env, timeoutMs: 90_000 })

    if (provider.stats.error) throw new Error(`deterministic provider assertion failed: ${provider.stats.error}`)
    assert.equal(provider.stats.phase, "done", `ordinary real request did not complete the expected provider cycle: ${JSON.stringify(provider.stats)}`)

    const afterOrdinary = await readOnlyGoal(project)
    assert.equal(afterOrdinary.id, goal.id)
    assert.equal(afterOrdinary.revision, goal.revision)
    assert.equal(afterOrdinary.objective, goal.objective)

    console.log(JSON.stringify({
      ok: true,
      platform: process.platform,
      node: process.version,
      opencode2Version: version.stdout.trim(),
      sessionID,
      objective: goal.objective,
      status: goal.status,
      commandStdout: commandResult.stdout.trim().slice(-2000),
      ordinaryStdout: ordinaryResult.stdout.trim().slice(-2000),
      providerRequests: provider.stats.requests,
    }, null, 2))
  } catch (error) {
    console.error(`provider state:\n${JSON.stringify(provider.stats, null, 2)}`)
    if (commandResult) console.error(`command stdout:\n${commandResult.stdout}\ncommand stderr:\n${commandResult.stderr}`)
    if (ordinaryResult) console.error(`ordinary stdout:\n${ordinaryResult.stdout}\nordinary stderr:\n${ordinaryResult.stderr}`)
    throw error
  } finally {
    await run("opencode2", ["service", "stop"], { cwd: project, env, allowFailure: true, timeoutMs: 15_000 }).catch(() => undefined)
    await provider.close().catch(() => undefined)
    await rm(temp, { recursive: true, force: true }).catch(() => undefined)
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
