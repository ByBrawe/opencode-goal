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
const MODEL = { providerID: "canary", id: "canary" }
const MISMATCH_ARGUMENTS = "mismatch objective must never persist"
const EXACT_ARGUMENTS = 'real v2 goal behavior --success "exact args persist" --constraint "no unrelated mutation"'
const PLAN_ARGUMENTS = 'plan safety canary --success "saved but paused"'
const ORDINARY_TEXT = "ordinary follow-up must not receive Goal lifecycle control"

function appendLog(current, chunk, limit = 80_000) {
  return (current + String(chunk)).slice(-limit)
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
    if (typeof part?.text === "string") return part.text
    if (typeof part?.content === "string") return part.content
    if (typeof part?.output === "string") return part.output
    return ""
  }).join("\n")
}

function allMessageText(body) {
  return (body.messages ?? []).map((message) => contentText(message?.content)).join("\n")
}

function toolNames(body) {
  return (body.tools ?? []).map((item) => item?.function?.name ?? item?.name).filter((item) => typeof item === "string")
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
    phase: "idle",
    phaseRequests: 0,
    chatRequests: 0,
    firstMismatchControlExposed: false,
    mismatchErrorSeen: false,
    postMismatchControlExposed: false,
    firstExactControlExposed: false,
    exactWrapperSeen: false,
    postExactControlExposed: false,
    ordinaryControlExposed: false,
    firstPlanControlExposed: false,
    postPlanControlExposed: false,
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
    stats.phaseRequests += 1
    stats.observations.push({
      phase: stats.phase,
      request: stats.phaseRequests,
      tools: names,
      hasControl: names.includes(CONTROL_TOOL),
      hasGet: names.includes(GET_TOOL),
      sawExactArguments: text.includes(EXACT_ARGUMENTS),
    })
    const id = `chatcmpl-v2-goal-${stats.chatRequests}`
    const created = Math.floor(Date.now() / 1000)

    if (stats.phase === "mismatch") {
      if (stats.phaseRequests === 1) {
        stats.firstMismatchControlExposed = names.includes(CONTROL_TOOL)
        streamToolCall(res, {
          id,
          created,
          callID: "call-v2-mismatch",
          name: CONTROL_TOOL,
          args: { arguments: "different arguments must be rejected" },
        })
        return
      }
      stats.postMismatchControlExposed ||= names.includes(CONTROL_TOOL)
      stats.mismatchErrorSeen ||= /no matching single-use \/goal command capability/i.test(text)
      streamText(res, { id, created, content: "MISMATCH_REJECTED" })
      return
    }

    if (stats.phase === "exact") {
      if (stats.phaseRequests === 1) {
        stats.firstExactControlExposed = names.includes(CONTROL_TOOL)
        stats.exactWrapperSeen = text.includes(EXACT_ARGUMENTS) && /OpenCode Goals V2 command wrapper/i.test(text)
        streamToolCall(res, {
          id,
          created,
          callID: "call-v2-exact",
          name: CONTROL_TOOL,
          args: { arguments: EXACT_ARGUMENTS },
        })
        return
      }
      stats.postExactControlExposed ||= names.includes(CONTROL_TOOL)
      streamText(res, { id, created, content: "EXACT_CONTROL_DONE" })
      return
    }

    if (stats.phase === "ordinary") {
      stats.ordinaryControlExposed ||= names.includes(CONTROL_TOOL)
      streamText(res, { id, created, content: "ORDINARY_DONE" })
      return
    }

    if (stats.phase === "plan") {
      if (stats.phaseRequests === 1) {
        stats.firstPlanControlExposed = names.includes(CONTROL_TOOL)
        streamToolCall(res, {
          id,
          created,
          callID: "call-v2-plan",
          name: CONTROL_TOOL,
          args: { arguments: PLAN_ARGUMENTS },
        })
        return
      }
      stats.postPlanControlExposed ||= names.includes(CONTROL_TOOL)
      streamText(res, { id, created, content: "PLAN_CONTROL_DONE" })
      return
    }

    streamText(res, { id, created, content: "IDLE_CANARY" })
  })

  return {
    stats,
    setPhase(phase) {
      stats.phase = phase
      stats.phaseRequests = 0
    },
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
    default_agent: "build",
    providers: {
      canary: {
        name: "Deterministic V2 Goal Behavior Canary",
        package: "aisdk:@ai-sdk/openai-compatible",
        settings: {
          baseURL: `http://127.0.0.1:${providerPort}/v1`,
          apiKey: "canary-key",
        },
        models: {
          canary: {
            modelID: "canary",
            name: "Deterministic V2 Goal Behavior Canary",
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

  const api = async (method, pathname, dataValue) => {
    const args = ["api", method.toLowerCase(), pathname]
    if (dataValue !== undefined) args.push("--data", JSON.stringify(dataValue))
    const result = await run("opencode2", args, { cwd: project, env, timeout: 90_000 })
    const text = String(result.stdout ?? "").trim()
    if (!text) return null
    return parseJSONOutput(result, `${method.toUpperCase()} ${pathname}`)
  }

  const createSession = async ({ title, agent }) => {
    const response = await api("post", "/api/session", {
      title,
      agent,
      model: MODEL,
      location: { directory: project },
    })
    const session = response?.data ?? response
    const id = String(session?.id ?? "")
    assert.ok(id, `OpenCode 2 did not create a session: ${JSON.stringify(response)}`)
    assert.equal(path.resolve(session.location?.directory ?? ""), path.resolve(project))
    return id
  }

  const runGoalCommand = async (sessionID, rawArguments, agent) => {
    await api("post", `/api/session/${encodeURIComponent(sessionID)}/command`, {
      command: "goal",
      arguments: rawArguments,
      agent,
      model: MODEL,
      resume: true,
    })
    await api("post", `/api/session/${encodeURIComponent(sessionID)}/wait`)
  }

  const runPrompt = async (sessionID, text, agent) => {
    await api("post", `/api/session/${encodeURIComponent(sessionID)}/prompt`, {
      text,
      agent,
      resume: true,
    })
    await api("post", `/api/session/${encodeURIComponent(sessionID)}/wait`)
  }

  try {
    await run("opencode2", ["service", "stop"], { cwd: project, env, allowFailure: true, timeout: 20_000 })
    const version = String((await run("opencode2", ["--version"], { cwd: project, env, timeout: 30_000 })).stdout ?? "").trim()
    assert.ok(version, "opencode2 --version returned no output")
    const health = await api("get", "/api/health")
    assert.ok(health, "OpenCode 2 health API returned no payload")

    const buildSession = await createSession({ title: "OpenCode Goals V2 behavior", agent: "build" })
    const store = new GoalStore(project)

    provider.setPhase("mismatch")
    await runGoalCommand(buildSession, MISMATCH_ARGUMENTS, "build")
    assert.equal(provider.stats.firstMismatchControlExposed, true, "authorized /goal command did not expose V2 control on its first provider request")
    assert.equal(provider.stats.mismatchErrorSeen, true, "real host did not return the exact-argument capability rejection to the model")
    assert.equal(await store.load(buildSession), null, "mismatched control arguments must not persist Goal state")
    assert.equal(provider.stats.postMismatchControlExposed, false, "a rejected single-use control capability was re-exposed on the next provider request")

    provider.setPhase("exact")
    await runGoalCommand(buildSession, EXACT_ARGUMENTS, "build")
    assert.equal(provider.stats.firstExactControlExposed, true, "authorized /goal command did not retain V2 control")
    assert.equal(provider.stats.exactWrapperSeen, true, "real command.transform path did not deliver the exact raw /goal arguments through the wrapper")
    const exactGoal = await store.load(buildSession)
    assert.ok(exactGoal, "exact V2 control did not persist Goal state")
    assert.equal(exactGoal.objective, "real v2 goal behavior")
    assert.deepEqual(exactGoal.constraints, ["no unrelated mutation"])
    assert.equal(exactGoal.execution?.agent, "build")
    assert.equal(provider.stats.postExactControlExposed, false, "consumed V2 control capability was re-exposed after the successful tool call")

    provider.setPhase("ordinary")
    await runPrompt(buildSession, ORDINARY_TEXT, "build")
    assert.equal(provider.stats.ordinaryControlExposed, false, "ordinary request exposed the V2 Goal lifecycle control tool")
    assert.deepEqual(await store.load(buildSession), exactGoal, "ordinary request unexpectedly mutated persisted Goal state")

    const planSession = await createSession({ title: "OpenCode Goals V2 Plan safety", agent: "plan" })
    provider.setPhase("plan")
    await runGoalCommand(planSession, PLAN_ARGUMENTS, "plan")
    assert.equal(provider.stats.firstPlanControlExposed, true, "authorized Plan /goal command did not expose the request-scoped control")
    assert.equal(provider.stats.postPlanControlExposed, false, "Plan command re-exposed a consumed V2 control capability")
    const planGoal = await store.load(planSession)
    assert.ok(planGoal, "Plan /goal command did not persist the Goal contract")
    assert.equal(planGoal.objective, "plan safety canary")
    assert.equal(planGoal.status, "paused", "Plan must not activate implementation through experimental V2 control")
    assert.match(planGoal.stopReason ?? "", /Plan is a restricted execution agent/i)

    console.log(JSON.stringify({
      ok: true,
      platform: process.platform,
      node: process.version,
      opencode2Version: version,
      buildSession,
      planSession,
      exactGoalID: exactGoal.id,
      planGoalID: planGoal.id,
      provider: provider.stats,
    }, null, 2))
  } catch (error) {
    let logTail = ""
    const candidates = [
      path.join(data, "opencode", "log", "opencode.log"),
      path.join(state, "opencode", "log", "opencode.log"),
    ]
    for (const file of candidates) {
      try {
        logTail = (await readFile(file, "utf8")).slice(-40_000)
        if (logTail) break
      } catch {
        // Try the next log location.
      }
    }
    if (logTail) console.error(`OpenCode 2 server log tail:\n${logTail}`)
    console.error(`Provider observations:\n${JSON.stringify(provider.stats, null, 2)}`)
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
