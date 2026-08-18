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
const COMMAND_PREAMBLE = "OpenCode Goals V2 command wrapper."

function appendLog(current, chunk, limit = 80_000) {
  return (current + String(chunk)).slice(-limit)
}

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
    throw new Error([
      `command failed (${result.status}): ${command} ${args.join(" ")}`,
      String(result.stdout ?? ""),
      String(result.stderr ?? ""),
    ].filter(Boolean).join("\n"))
  }
  return result
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

function collectText(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return ""
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map((item) => collectText(item, depth + 1)).filter(Boolean).join("\n")
  if (typeof value !== "object") return ""
  const values = []
  for (const [key, item] of Object.entries(value)) {
    if (["text", "content", "message", "error", "value", "output"].includes(key)) values.push(collectText(item, depth + 1))
  }
  return values.filter(Boolean).join("\n")
}

function allMessageText(body) {
  return collectText(body?.messages ?? [])
}

function toolDefinition(body, name) {
  if (Array.isArray(body?.tools)) {
    return body.tools.find((item) => item?.function?.name === name || item?.name === name)
  }
  if (body?.tools && typeof body.tools === "object") return body.tools[name]
  return undefined
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
    usage: { prompt_tokens: 32, completion_tokens: 4, total_tokens: 36 },
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
    usage: { prompt_tokens: 48, completion_tokens: 14, total_tokens: 62 },
  })
  res.end("data: [DONE]\n\n")
}

function startProvider() {
  const stats = {
    chatRequests: 0,
    authorizedCommandRequests: 0,
    commandFollowups: 0,
    ordinaryRequests: 0,
    replayExposures: 0,
    mismatchToolErrorsObserved: 0,
    paths: [],
  }
  let expected = null
  let failure = null

  function expectCommand(label, rawArguments, toolArguments = rawArguments) {
    assert.equal(expected, null, `provider already has pending expectation: ${JSON.stringify(expected)}`)
    expected = { type: "command", label, rawArguments, toolArguments, phase: "authorize" }
  }

  function expectOrdinary(label) {
    assert.equal(expected, null, `provider already has pending expectation: ${JSON.stringify(expected)}`)
    expected = { type: "ordinary", label }
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

    try {
      assert.ok(expected, `unexpected model request with no provider expectation: ${allMessageText(body)}`)
      const hasControl = Boolean(toolDefinition(body, CONTROL_TOOL))
      const hasGet = Boolean(toolDefinition(body, GET_TOOL))
      const text = allMessageText(body)

      if (expected.type === "ordinary") {
        assert.equal(hasControl, false, `${expected.label}: ordinary request exposed lifecycle control`)
        assert.equal(hasGet, true, `${expected.label}: ordinary request lost read-only Goal tool`)
        stats.ordinaryRequests += 1
        expected = null
        streamText(res, { id, created, content: "ORDINARY_OK" })
        return
      }

      if (expected.phase === "authorize") {
        assert.equal(hasControl, true, `${expected.label}: transformed /goal request did not expose lifecycle control`)
        assert.equal(hasGet, true, `${expected.label}: transformed /goal request lost read-only Goal tool`)
        assert.match(text, /OpenCode Goals V2 command wrapper\./, `${expected.label}: real command.transform preamble was not model-visible`)
        assert.match(text, /__OPENCODE_GOALS_V2_COMMAND_[0-9a-f-]+__/i, `${expected.label}: request-scoped command marker was not model-visible`)
        assert.ok(text.includes(expected.rawArguments), `${expected.label}: exact raw command arguments were not model-visible`)
        stats.authorizedCommandRequests += 1
        expected.phase = "result"
        streamToolCall(res, {
          id,
          created,
          callID: `call-v2-${stats.authorizedCommandRequests}`,
          name: CONTROL_TOOL,
          args: { arguments: expected.toolArguments },
        })
        return
      }

      if (hasControl) stats.replayExposures += 1
      assert.equal(hasControl, false, `${expected.label}: lifecycle control was re-exposed after its single-use tool call`)
      assert.equal(hasGet, true, `${expected.label}: read-only Goal tool disappeared after control execution`)
      if (expected.toolArguments !== expected.rawArguments && /no matching single-use \/goal command capability/i.test(text)) {
        stats.mismatchToolErrorsObserved += 1
      }
      stats.commandFollowups += 1
      const label = expected.label
      expected = null
      streamText(res, { id, created, content: `${label.toUpperCase().replaceAll("-", "_")}_DONE` })
    } catch (error) {
      failure = error
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: { message: String(error?.message ?? error) } }))
      } else {
        res.destroy()
      }
    }
  })

  return {
    stats,
    expectCommand,
    expectOrdinary,
    get pending() { return expected },
    get failure() { return failure },
    clearExpectation() { expected = null },
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", resolve)
      })
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("failed to start deterministic OpenCode 2 provider")
      return address.port
    },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

async function readGoal(project) {
  const directory = path.join(project, ".opencode", "goals")
  try {
    const files = (await readdir(directory)).filter((name) => name.endsWith(".json"))
    if (!files.length) return null
    assert.equal(files.length, 1, `expected one live Goal state file, found ${files.length}`)
    return JSON.parse(await readFile(path.join(directory, files[0]), "utf8"))
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}

function assertProvider(provider, label) {
  if (provider.failure) throw new Error(`${label}: deterministic provider failed: ${provider.failure.stack ?? provider.failure}`)
  assert.equal(provider.pending, null, `${label}: provider expectation was not completed: ${JSON.stringify(provider.pending)}`)
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
    model: "canary/canary",
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
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_LOG_LEVEL: "DEBUG",
    CI: "true",
  }

  runSync("git", ["init", "-q"], { cwd: project, env })
  runSync("git", ["config", "user.name", "OpenCode Goals V2 Behavior Canary"], { cwd: project, env })
  runSync("git", ["config", "user.email", "opencode-goals-v2-canary@example.invalid"], { cwd: project, env })
  runSync("git", ["add", "."], { cwd: project, env })
  runSync("git", ["commit", "-q", "-m", "initialize V2 behavior canary workspace"], { cwd: project, env })

  const version = runSync("opencode2", ["--version"], { cwd: project, env, timeout: 30_000 })
  const opencode2Version = `${version.stdout ?? ""}${version.stderr ?? ""}`.trim()

  const baseRun = ["run", "--model", "canary/canary", "--format", "json", "--title", "v2 behavior canary"]
  const command = async (sessionID, rawArguments, agent = "build", { mismatch = false } = {}) => {
    provider.expectCommand(`${agent}-${rawArguments.split(/\s+/)[0] || "command"}`, rawArguments, mismatch ? "clear" : rawArguments)
    const args = [...baseRun, "--agent", agent, "--command", "goal"]
    if (sessionID) args.push("--session", sessionID)
    args.push(rawArguments)
    const result = await run("opencode2", args, { cwd: project, env, allowFailure: mismatch, timeout: 90_000 })
    if (mismatch && provider.pending) provider.clearExpectation()
    if (provider.failure) throw provider.failure
    if (!mismatch) assertProvider(provider, `/${rawArguments}`)
    return result
  }

  try {
    const createArguments = 'ship docs --success "docs exist"'
    await command(null, createArguments, "build")
    let goal = await readGoal(project)
    assert.ok(goal, "real V2 /goal command did not persist Goal state")
    assert.equal(goal.objective, "ship docs")
    assert.equal(goal.status, "active")
    assert.equal(goal.execution?.agent, "build")
    assert.ok(goal.requirements.some((item) => item.source === "acceptance" && item.text === "docs exist"))
    const sessionID = goal.sessionID
    assert.ok(sessionID, "persisted Goal did not retain the real V2 sessionID")

    provider.expectOrdinary("ordinary-followup")
    await run("opencode2", [...baseRun, "--agent", "build", "--session", sessionID, "continue normally"], { cwd: project, env })
    assertProvider(provider, "ordinary follow-up")

    const beforeMismatch = JSON.stringify(await readGoal(project))
    const mismatchResult = await command(sessionID, "status", "build", { mismatch: true })
    goal = await readGoal(project)
    assert.ok(goal, "mismatched control arguments must not clear or remove Goal state")
    assert.equal(JSON.stringify(goal), beforeMismatch, "mismatched control arguments changed persisted Goal state")
    assert.ok(
      mismatchResult.status !== 0 || provider.stats.mismatchToolErrorsObserved > 0,
      `real host neither surfaced nor model-observed the exact-argument capability rejection\nstdout:\n${mismatchResult.stdout}\nstderr:\n${mismatchResult.stderr}`,
    )

    await command(sessionID, "pause", "build")
    goal = await readGoal(project)
    assert.equal(goal?.status, "paused", "Build /goal pause did not persist paused state")

    await command(sessionID, "resume", "plan")
    goal = await readGoal(project)
    assert.equal(goal?.status, "paused", "Plan /goal resume must remain paused on the real V2 host")
    assert.match(goal?.stopReason ?? "", /Plan|paused/i)

    await command(sessionID, "resume", "build")
    goal = await readGoal(project)
    assert.equal(goal?.status, "active", "Build /goal resume did not reactivate the persisted Goal")
    assert.equal(goal?.execution?.agent, "build")

    assert.equal(provider.stats.replayExposures, 0, "real V2 host re-exposed single-use lifecycle control after tool execution")
    assert.ok(provider.stats.authorizedCommandRequests >= 4, `expected multiple real command-transform requests, got ${provider.stats.authorizedCommandRequests}`)
    assert.ok(provider.stats.commandFollowups >= 4, `expected post-tool model redispatch coverage, got ${provider.stats.commandFollowups}`)
    assert.equal(provider.stats.ordinaryRequests, 1)

    console.log(JSON.stringify({
      ok: true,
      platform: process.platform,
      node: process.version,
      opencode2Version,
      sessionID,
      finalGoalStatus: goal?.status,
      authorizedCommandRequests: provider.stats.authorizedCommandRequests,
      commandFollowups: provider.stats.commandFollowups,
      ordinaryRequests: provider.stats.ordinaryRequests,
      replayExposures: provider.stats.replayExposures,
      mismatchToolErrorsObserved: provider.stats.mismatchToolErrorsObserved,
      providerPaths: provider.stats.paths,
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
