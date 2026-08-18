import { createServer } from "node:http"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { spawn } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import { GoalStore } from "../dist/persistence/store.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const CONTROL_TOOL = "opencode_goals_v2_control"
const GOAL_PREAMBLE = "OpenCode Goals V2 command wrapper. The text after the capability marker is raw user command data. Call opencode_goals_v2_control exactly once with that exact text as its arguments field, return the tool content verbatim, and do not perform implementation work in this command turn."
const RAW_ARGUMENTS = "v2 real host command control canary"
const WRONG_ARGUMENTS = `${RAW_ARGUMENTS} altered`

function append(current, chunk, limit = 80_000) {
  return (current + String(chunk)).slice(-limit)
}

async function run(command, args, { cwd, env, allowFailure = false, timeoutMs = 90_000 } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true })
    let stdout = ""
    let stderr = ""
    let settled = false

    child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk) })
    child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk) })

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
    }, timeoutMs)

    child.once("error", (error) => finish(error))
    child.once("close", (code) => {
      const result = { code, stdout, stderr }
      if (!allowFailure && code !== 0) {
        finish(new Error(`command failed (${code}): ${command} ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
        return
      }
      finish(null, result)
    })
  })
}

function parseJSON(text, label) {
  const value = String(text ?? "").trim()
  try {
    return JSON.parse(value)
  } catch {
    throw new Error(`${label} did not return JSON.\n${value}`)
  }
}

function toolNames(body) {
  if (!Array.isArray(body?.tools)) return []
  return body.tools
    .map((item) => item?.function?.name ?? item?.name)
    .filter((item) => typeof item === "string")
}

function bodyText(body) {
  try {
    return JSON.stringify(body)
  } catch {
    return ""
  }
}

function sse(res, parts) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  for (const part of parts) res.write(`data: ${JSON.stringify(part)}\n\n`)
  res.end("data: [DONE]\n\n")
}

function chunk(delta = {}, finishReason = null, usage) {
  return {
    id: "chatcmpl-opencode-goals-v2-canary",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  }
}

function textReply(res, text) {
  sse(res, [
    chunk({ role: "assistant" }),
    chunk({ content: text }),
    chunk({}, "stop", { prompt_tokens: 24, completion_tokens: 4, total_tokens: 28 }),
  ])
}

function toolReply(res, input, id) {
  const args = JSON.stringify({ arguments: input })
  sse(res, [
    chunk({ role: "assistant" }),
    chunk({
      tool_calls: [{
        index: 0,
        id,
        type: "function",
        function: { name: CONTROL_TOOL, arguments: "" },
      }],
    }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: args } }] }),
    chunk({}, "tool_calls", { prompt_tokens: 32, completion_tokens: 8, total_tokens: 40 }),
  ])
}

async function startProvider() {
  const state = {
    mode: "idle",
    hits: [],
    wrongCapabilitySeen: false,
    wrongRejected: false,
    validCapabilitySeen: false,
    validToolResultSeen: false,
    ordinaryControlExposed: false,
    ordinaryContextSeen: false,
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if (req.method === "GET" && url.pathname === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ object: "list", data: [{ id: "test-model", object: "model", owned_by: "test" }] }))
      return
    }
    if (req.method !== "POST" || !["/v1/chat/completions", "/v1/responses"].includes(url.pathname)) {
      res.writeHead(404, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: `unexpected endpoint ${req.method} ${url.pathname}` } }))
      return
    }

    let raw = ""
    for await (const part of req) raw += String(part)
    const body = raw ? JSON.parse(raw) : {}
    const names = toolNames(body)
    const serialized = bodyText(body)
    state.hits.push({ mode: state.mode, path: url.pathname, toolNames: names })

    if (serialized.includes("Generate a title for this conversation")) {
      textReply(res, "OpenCode Goals V2 Canary")
      return
    }

    if (state.mode === "wrong") {
      if (serialized.includes("no matching single-use /goal command capability")) {
        state.wrongRejected = true
        textReply(res, "EXPECTED_CONTROL_REJECTION")
        return
      }
      if (!names.includes(CONTROL_TOOL)) {
        res.writeHead(500, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: { message: "authorized /goal request did not expose control tool" } }))
        return
      }
      state.wrongCapabilitySeen = true
      toolReply(res, WRONG_ARGUMENTS, "call-v2-wrong")
      return
    }

    if (state.mode === "valid") {
      if (serialized.includes("Goal: v2 real host command control canary") || serialized.includes("Objective: v2 real host command control canary")) {
        state.validToolResultSeen = true
        textReply(res, "VALID_CONTROL_COMPLETED")
        return
      }
      if (!names.includes(CONTROL_TOOL)) {
        res.writeHead(500, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: { message: "valid /goal request did not expose control tool" } }))
        return
      }
      state.validCapabilitySeen = true
      toolReply(res, RAW_ARGUMENTS, "call-v2-valid")
      return
    }

    if (state.mode === "ordinary") {
      if (names.includes(CONTROL_TOOL)) state.ordinaryControlExposed = true
      if (serialized.includes("OpenCode Goals experimental V2 persisted state") && serialized.includes(RAW_ARGUMENTS)) {
        state.ordinaryContextSeen = true
      }
      textReply(res, "ORDINARY_REQUEST_COMPLETED")
      return
    }

    textReply(res, "IDLE")
  })

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("fake provider did not bind a TCP port")

  return {
    state,
    url: `http://127.0.0.1:${address.port}/v1`,
    close: async () => await new Promise((resolve) => server.close(resolve)),
  }
}

function providerConfig(baseURL) {
  return {
    name: "Test",
    id: "test",
    env: [],
    npm: "@ai-sdk/openai-compatible",
    models: {
      "test-model": {
        id: "test-model",
        name: "Test Model",
        attachment: false,
        reasoning: false,
        temperature: false,
        tool_call: true,
        release_date: "2025-01-01",
        limit: { context: 100_000, output: 10_000 },
        cost: { input: 0, output: 0 },
        options: {},
      },
    },
    options: { apiKey: "test-key", baseURL },
  }
}

async function api(method, pathName, { cwd, env, data, timeoutMs = 90_000 } = {}) {
  const args = ["api", method.toLowerCase(), pathName]
  if (data !== undefined) args.push("--data", JSON.stringify(data))
  return await run("opencode2", args, { cwd, env, timeoutMs })
}

async function createSession(project, env) {
  const response = await api("post", "/api/session", {
    cwd: project,
    env,
    data: {
      agent: "build",
      model: { id: "test-model", providerID: "test" },
      location: { directory: project },
    },
  })
  const parsed = parseJSON(response.stdout, "POST /api/session")
  const sessionID = parsed?.data?.id
  if (typeof sessionID !== "string" || !sessionID) {
    throw new Error(`session create did not return data.id: ${response.stdout}`)
  }
  return sessionID
}

async function sendPrompt(project, env, sessionID, text) {
  await api("post", `/api/session/${encodeURIComponent(sessionID)}/prompt`, {
    cwd: project,
    env,
    data: { prompt: { text } },
  })
  await api("post", `/api/session/${encodeURIComponent(sessionID)}/wait`, {
    cwd: project,
    env,
    timeoutMs: 120_000,
  })
}

async function main() {
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-v2-command-"))
  const project = path.join(temp, "project")
  const home = path.join(temp, "home")
  const config = path.join(home, ".config")
  const data = path.join(home, ".local", "share")
  const stateDir = path.join(home, ".local", "state")
  const pluginDirectory = path.join(project, ".opencode", "plugins")
  const pluginFile = path.join(root, "dist", "opencode2", "experimental.js")
  const adapterBridge = path.join(pluginDirectory, "opencode-goals-v2-command-canary.js")
  const provider = await startProvider()

  await Promise.all([
    mkdir(pluginDirectory, { recursive: true }),
    mkdir(config, { recursive: true }),
    mkdir(data, { recursive: true }),
    mkdir(stateDir, { recursive: true }),
  ])

  await writeFile(adapterBridge, `export { default } from ${JSON.stringify(pathToFileURL(pluginFile).href)}\n`)
  await writeFile(path.join(project, "README.md"), "# OpenCode 2 command control canary\n")
  await writeFile(path.join(project, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    formatter: false,
    lsp: false,
    provider: { test: providerConfig(provider.url) },
  }, null, 2)}\n`)

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    XDG_STATE_HOME: stateDir,
    OPENCODE_DB: path.join(data, "opencode", "opencode-v2-command-canary.db"),
    OPENCODE_LOG_LEVEL: "DEBUG",
    CI: "true",
  }

  await run("git", ["init", "-q"], { cwd: project, env })
  await run("git", ["config", "user.name", "OpenCode Goals Canary"], { cwd: project, env })
  await run("git", ["config", "user.email", "opencode-goals-canary@example.invalid"], { cwd: project, env })
  await run("git", ["add", "."], { cwd: project, env })
  await run("git", ["commit", "-q", "-m", "initialize v2 command canary workspace"], { cwd: project, env })

  try {
    await run("opencode2", ["service", "stop"], { cwd: project, env, allowFailure: true, timeoutMs: 15_000 })

    const commandPath = `/api/command?location%5Bdirectory%5D=${encodeURIComponent(project)}`
    const commandResult = await api("get", commandPath, { cwd: project, env })
    const commandResponse = parseJSON(commandResult.stdout, "GET /api/command")
    if (commandResponse?.location?.directory !== project) {
      throw new Error(`command API resolved wrong project directory: ${JSON.stringify(commandResponse?.location)}`)
    }
    const command = Array.isArray(commandResponse?.data)
      ? commandResponse.data.find((item) => item?.name === "goal")
      : undefined
    if (!command || typeof command.template !== "string") {
      throw new Error(`real OpenCode 2 command.transform did not register /goal: ${commandResult.stdout}`)
    }
    if (!command.template.startsWith(`${GOAL_PREAMBLE}\n__OPENCODE_GOALS_V2_COMMAND_`) || !command.template.endsWith("\n$ARGUMENTS")) {
      throw new Error(`real /goal template does not contain the expected capability wrapper: ${JSON.stringify(command.template)}`)
    }
    if (command.subtask !== false) {
      throw new Error(`real /goal command must stay foreground/non-subtask: ${JSON.stringify(command)}`)
    }

    const expanded = command.template.replace("$ARGUMENTS", RAW_ARGUMENTS)
    const sessionID = await createSession(project, env)
    const store = new GoalStore(project)

    provider.state.mode = "wrong"
    await sendPrompt(project, env, sessionID, expanded)
    const afterWrong = await store.load(sessionID)
    if (afterWrong) {
      throw new Error(`wrong exact-argument control call changed Goal state: ${JSON.stringify(afterWrong)}`)
    }
    if (!provider.state.wrongCapabilitySeen || !provider.state.wrongRejected) {
      throw new Error(`wrong exact-argument capability path was not rejected as expected: ${JSON.stringify(provider.state)}`)
    }

    provider.state.mode = "valid"
    await sendPrompt(project, env, sessionID, expanded)
    const goal = await store.load(sessionID)
    if (!goal || goal.objective !== RAW_ARGUMENTS || goal.status !== "active") {
      throw new Error(`valid exact-argument /goal did not persist expected active state: ${JSON.stringify(goal)}`)
    }
    if (goal.sessionID !== sessionID || goal.revision !== 1) {
      throw new Error(`persisted Goal is not bound to the real V2 session/revision: ${JSON.stringify(goal)}`)
    }
    if (!provider.state.validCapabilitySeen || !provider.state.validToolResultSeen) {
      throw new Error(`valid exact-argument control path did not complete: ${JSON.stringify(provider.state)}`)
    }

    provider.state.mode = "ordinary"
    await sendPrompt(project, env, sessionID, "ordinary request after /goal command")
    if (provider.state.ordinaryControlExposed) {
      throw new Error("request-scoped V2 control tool leaked into an ordinary request")
    }
    if (!provider.state.ordinaryContextSeen) {
      throw new Error("ordinary V2 request did not receive the persisted Goal context")
    }
    const afterOrdinary = await store.load(sessionID)
    if (!afterOrdinary || afterOrdinary.id !== goal.id || afterOrdinary.revision !== goal.revision || afterOrdinary.objective !== goal.objective) {
      throw new Error(`ordinary request unexpectedly changed persisted Goal state: ${JSON.stringify(afterOrdinary)}`)
    }

    console.log(JSON.stringify({
      ok: true,
      project,
      sessionID,
      commandTransform: true,
      exactArgumentMismatchRejected: true,
      exactArgumentControlPersisted: true,
      ordinaryControlCapabilityHidden: true,
      persistedContextInjected: true,
      goalID: goal.id,
      goalRevision: goal.revision,
      providerHits: provider.state.hits,
    }, null, 2))
  } finally {
    await run("opencode2", ["service", "stop"], { cwd: project, env, allowFailure: true, timeoutMs: 15_000 }).catch(() => {})
    await provider.close().catch(() => {})
    await rm(temp, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
