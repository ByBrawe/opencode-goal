import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const serverFile = path.join(root, "dist", "server.js")
const SERVER_USERNAME = "opencode"
const SERVER_PASSWORD = "opencode-goal-v2-direct-lifecycle"
const OPENCODE_BINARY = process.env.OPENCODE2_BINARY || "opencode2"
const DIRECT_ENV = "OPENCODE_GOAL_V2_DIRECT_LIFECYCLE"
const CONTROL_TOOL = "opencode_goals_v2_control"
const READ_ONLY_TOOL = "opencode_goals_v2_get"
const CREATE_COMMAND = 'ship v2 capability --accept "preview persists" --constraint "no spoof mutation" --max-turns 7'
const PAUSE_COMMAND = "pause"
const RESUME_COMMAND = "resume"
const EDIT_COMMAND = 'edit ship v2 capability revised --constraint "preserve API" --max-turns 9'
const MISMATCH_COMMAND = 'edit MISMATCH_CAPABILITY_TARGET --constraint "must not persist"'
const CLEAR_COMMAND = "clear"
const SPOOF_SENTINEL = "SPOOF_DIRECT_COMMAND_CAPABILITY"
const PLAN_SENTINEL = "PLAN_CAPABILITY_MUST_NOT_MUTATE"
const FOLLOWUP_SENTINEL = "POST_CAPABILITY_FOLLOWUP"

function appendLog(current, chunk, limit = 120_000) {
  return (current + String(chunk)).slice(-limit)
}

function shard(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 32)
}

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") return reject(new Error("failed to reserve TCP port"))
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

async function waitForTcp(port, child, logs, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`OpenCode 2 server exited before ready.\n${logs()}`)
    const connected = await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port })
      socket.once("connect", () => {
        socket.destroy()
        resolve(true)
      })
      socket.once("error", () => resolve(false))
      socket.setTimeout(500, () => {
        socket.destroy()
        resolve(false)
      })
    })
    if (connected) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for OpenCode 2 server on ${port}\n${logs()}`)
}

async function stopProcess(child, timeoutMs = 5_000) {
  if (!child || child.exitCode !== null) return
  child.kill("SIGTERM")
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve()
    const timer = setTimeout(resolve, timeoutMs)
    child.once("close", () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function waitFor(predicate, description, diagnostics, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for ${description}\n${await diagnostics()}`)
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

function messageText(body) {
  return (Array.isArray(body?.messages) ? body.messages : []).map((message) => {
    return `${String(message?.role || "")}: ${contentText(message?.content)}`
  }).join("\n")
}

function latestUserTurn(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (String(message?.role || "").toLowerCase() !== "user") continue
    return {
      userText: contentText(message?.content),
      turnText: messages.slice(index).map((item) => {
        return `${String(item?.role || "")}: ${contentText(item?.content)}`
      }).join("\n"),
    }
  }
  return { userText: "", turnText: "" }
}

function toolNames(body) {
  if (Array.isArray(body?.tools)) {
    return body.tools
      .map((item) => item?.function?.name ?? item?.name)
      .filter((name) => typeof name === "string")
  }
  if (body?.tools && typeof body.tools === "object") return Object.keys(body.tools)
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

function streamToolCall(res, sequence, command) {
  const id = `chatcmpl-goal-v2-direct-${sequence}`
  const created = Math.floor(Date.now() / 1000)
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
          id: `call-goal-v2-direct-${sequence}`,
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
          function: { arguments: JSON.stringify({ command }) },
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
    usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 },
  })
  res.end("data: [DONE]\n\n")
}

function streamText(res, sequence, text = `DIRECT_LIFECYCLE_PROVIDER_${sequence}`) {
  const id = `chatcmpl-goal-v2-direct-${sequence}`
  const created = Math.floor(Date.now() / 1000)
  streamHeaders(res)
  writeSse(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model: "canary",
    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
  })
  writeSse(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model: "canary",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 },
  })
  res.end("data: [DONE]\n\n")
}

function authorizedCommandFromText(text) {
  if (text.includes(MISMATCH_COMMAND)) return "clear"
  for (const command of [CREATE_COMMAND, PAUSE_COMMAND, RESUME_COMMAND, EDIT_COMMAND, CLEAR_COMMAND]) {
    if (text.includes(command)) return command
  }
  return ""
}

function startProvider() {
  const stats = { requests: [] }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if (req.method === "GET" && url.pathname.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({
        object: "list",
        data: [{ id: "canary", object: "model", owned_by: "canary" }],
      }))
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
    const sequence = stats.requests.length + 1
    const tools = toolNames(body)
    const text = messageText(body)
    const currentTurn = latestUserTurn(body)
    const currentUserText = currentTurn.userText
    const hasControlTool = tools.includes(CONTROL_TOOL)
    const sawConsumedResult = /single-use capability is consumed/i.test(currentTurn.turnText)
    const command = hasControlTool && !sawConsumedResult ? authorizedCommandFromText(currentUserText) : ""

    stats.requests.push({
      sequence,
      text: text.slice(-9000),
      currentUserText,
      tools,
      hasControlTool,
      sawConsumedResult,
      toolCommand: command,
      sawSpoof: currentUserText.includes(SPOOF_SENTINEL),
      sawPlan: currentUserText.includes(PLAN_SENTINEL),
      sawFollowup: currentUserText.includes(FOLLOWUP_SENTINEL),
    })

    if (hasControlTool && !sawConsumedResult) {
      if (!command) {
        streamText(res, sequence, "CONTROL_TOOL_VISIBLE_WITHOUT_RECOGNIZED_COMMAND")
        return
      }
      streamToolCall(res, sequence, command)
      return
    }
    streamText(res, sequence)
  })

  return {
    stats,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", resolve)
      })
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("deterministic provider did not bind")
      return address.port
    },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

function commandNames(payload) {
  const data = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : []
  return new Set(data.map((item) => item?.name ?? item?.id).filter((name) => typeof name === "string"))
}

async function readGoal(workspace, sessionID) {
  try {
    return JSON.parse(await readFile(path.join(workspace, ".opencode", "goals", `${shard(sessionID)}.json`), "utf8"))
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}

async function readArchive(workspace, sessionID, goalID) {
  try {
    const file = path.join(workspace, ".opencode", "goals", "history", shard(sessionID), `${shard(goalID)}.json`)
    return JSON.parse(await readFile(file, "utf8"))
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}

async function main() {
  assert.equal(process.platform, "linux", "the exact OpenCode 2 direct lifecycle canary is intentionally Ubuntu-only")

  const workspace = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-v2-direct-"))
  const foreignWorkspace = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-v2-direct-foreign-"))
  const home = path.join(workspace, ".home")
  const pluginDir = path.join(workspace, ".opencode", "plugins")
  const foreignPluginDir = path.join(foreignWorkspace, ".opencode", "plugins")
  const bridge = path.join(pluginDir, "opencode-goal-server.js")
  const provider = startProvider()
  const providerPort = await provider.listen()

  let server
  let serverLog = ""
  let apiPrefix = null
  let sessionID = ""
  let latestCommands = new Set()

  await Promise.all([
    mkdir(pluginDir, { recursive: true }),
    mkdir(foreignPluginDir, { recursive: true }),
    mkdir(path.join(home, ".config"), { recursive: true }),
    mkdir(path.join(home, ".local", "share"), { recursive: true }),
    mkdir(path.join(home, ".local", "state"), { recursive: true }),
    mkdir(path.join(home, ".cache"), { recursive: true }),
  ])

  await writeFile(bridge, `export { default } from ${JSON.stringify(pathToFileURL(serverFile).href)}\n`, "utf8")
  await writeFile(path.join(workspace, "README.md"), "# OpenCode Goal V2 direct lifecycle canary\n", "utf8")
  await writeFile(path.join(workspace, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "canary/canary",
    providers: {
      canary: {
        name: "Deterministic OpenCode Goal V2 Direct Lifecycle Canary",
        package: "@opencode-ai/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${providerPort}/v1` },
        models: {
          canary: {
            name: "Deterministic OpenCode Goal V2 Direct Lifecycle Canary",
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            limit: { context: 100000, output: 4096 },
          },
        },
      },
    },
  }, null, 2)}\n`, "utf8")

  await writeFile(path.join(foreignPluginDir, "opencode-goal-server.js"), `export { default } from ${JSON.stringify(pathToFileURL(serverFile).href)}\n`, "utf8")
  await writeFile(path.join(foreignWorkspace, "README.md"), "# OpenCode Goal V2 foreign-location canary\n", "utf8")
  await writeFile(
    path.join(foreignWorkspace, "opencode.json"),
    await readFile(path.join(workspace, "opencode.json"), "utf8"),
    "utf8",
  )

  execFileSync("git", ["init", "--quiet", workspace], { stdio: "ignore" })
  execFileSync("git", ["-C", workspace, "config", "user.email", "opencode-goal-ci@example.invalid"], { stdio: "ignore" })
  execFileSync("git", ["-C", workspace, "config", "user.name", "OpenCode Goal CI"], { stdio: "ignore" })
  execFileSync("git", ["-C", workspace, "add", "."], { stdio: "ignore" })
  execFileSync("git", ["-C", workspace, "commit", "--quiet", "-m", "init"], { stdio: "ignore" })
  execFileSync("git", ["init", "--quiet", foreignWorkspace], { stdio: "ignore" })
  execFileSync("git", ["-C", foreignWorkspace, "config", "user.email", "opencode-goal-ci@example.invalid"], { stdio: "ignore" })
  execFileSync("git", ["-C", foreignWorkspace, "config", "user.name", "OpenCode Goal CI"], { stdio: "ignore" })
  execFileSync("git", ["-C", foreignWorkspace, "add", "."], { stdio: "ignore" })
  execFileSync("git", ["-C", foreignWorkspace, "commit", "--quiet", "-m", "init"], { stdio: "ignore" })

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    [DIRECT_ENV]: "1",
    OPENCODE_SERVER_USERNAME: SERVER_USERNAME,
    OPENCODE_SERVER_PASSWORD: SERVER_PASSWORD,
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    CI: "true",
  }

  const diagnostics = async () => {
    const goal = sessionID ? await readGoal(workspace, sessionID).catch((error) => ({ error: String(error) })) : null
    let goalFiles = []
    try { goalFiles = await readdir(path.join(workspace, ".opencode", "goals"), { recursive: true }) } catch {}
    return [
      `apiPrefix=${String(apiPrefix)}`,
      `commands=${JSON.stringify([...latestCommands])}`,
      `sessionID=${sessionID || "none"}`,
      `goal=${JSON.stringify(goal)}`,
      `goalFiles=${JSON.stringify(goalFiles)}`,
      `provider=${JSON.stringify(provider.stats)}`,
      `serverExit=${server?.exitCode}`,
      `serverLog=${serverLog}`,
    ].join("\n")
  }

  try {
    const version = String(execFileSync(OPENCODE_BINARY, ["--version"], {
      cwd: workspace,
      env,
      encoding: "utf8",
      windowsHide: true,
    })).trim()
    assert.ok(version.includes("2.0.11"), `expected exact OpenCode 2.0.11, got: ${version}`)

    const port = await reservePort()
    server = spawn(OPENCODE_BINARY, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: workspace,
      env,
      windowsHide: true,
    })
    server.stdout?.on("data", (chunk) => { serverLog = appendLog(serverLog, chunk) })
    server.stderr?.on("data", (chunk) => { serverLog = appendLog(serverLog, chunk) })
    await waitForTcp(port, server, () => serverLog)

    const baseURL = `http://127.0.0.1:${port}`
    const authorization = `Basic ${Buffer.from(`${SERVER_USERNAME}:${SERVER_PASSWORD}`).toString("base64")}`
    const request = async (pathname, init = {}, timeoutMs = 30_000) => {
      const response = await fetch(`${baseURL}${pathname}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          "x-opencode-directory": workspace,
          authorization,
          ...(init.headers ?? {}),
        },
        signal: init.signal ?? AbortSignal.timeout(timeoutMs),
      })
      const text = await response.text()
      let body = null
      if (text) {
        try { body = JSON.parse(text) } catch { body = text }
      }
      return { ok: response.ok, status: response.status, body, text }
    }

    for (const prefix of ["/api", ""]) {
      const response = await request(`${prefix}/command`, { method: "GET" }, 10_000).catch(() => null)
      if (response?.ok) {
        apiPrefix = prefix
        break
      }
    }
    assert.notEqual(apiPrefix, null, `OpenCode 2 command API never became ready\n${await diagnostics()}`)

    await waitFor(async () => {
      const response = await request(`${apiPrefix}/command`, { method: "GET" }, 5_000)
      if (!response.ok) return false
      latestCommands = commandNames(response.body)
      return latestCommands.has("goal")
    }, "direct goal command registration", diagnostics, 30_000)

    const created = await request(`${apiPrefix}/session`, {
      method: "POST",
      body: JSON.stringify({ title: "OpenCode Goal V2 direct lifecycle" }),
    })
    assert.ok(created.ok, `session create failed: HTTP ${created.status} ${created.text}\n${await diagnostics()}`)
    sessionID = String((created.body?.data ?? created.body)?.id ?? "")
    assert.ok(sessionID, `session ID missing: ${created.text}`)

    const command = async (text, expectOK = true) => {
      const response = await request(`${apiPrefix}/session/${encodeURIComponent(sessionID)}/command`, {
        method: "POST",
        body: JSON.stringify({ name: "goal", text }),
      }, 90_000)
      if (expectOK) assert.ok(response.ok, `/goal ${text} failed: HTTP ${response.status} ${response.text}\n${await diagnostics()}`)
      return response
    }

    const requestsFor = (needle) => provider.stats.requests.filter((item) => item.currentUserText.includes(needle))
    const assertAuthorizedTurn = (needle) => {
      const requests = requestsFor(needle)
      assert.ok(requests.length >= 2, `expected tool-call and continuation requests for ${needle}\n${JSON.stringify(provider.stats, null, 2)}`)
      const authorized = requests.find((item) => item.hasControlTool && item.toolCommand !== "")
      assert.ok(authorized, `authorized request did not expose and call the control tool for ${needle}\n${JSON.stringify(requests, null, 2)}`)
      const consumed = requests.find((item) => item.sequence > authorized.sequence && item.sawConsumedResult)
      assert.ok(consumed, `tool result did not reach continuation for ${needle}`)
      assert.equal(consumed.hasControlTool, false, `consumed capability remained visible on continuation for ${needle}`)
      assert.ok(consumed.tools.includes(READ_ONLY_TOOL), `read-only Goal inspection disappeared after consuming capability for ${needle}`)
    }

    const requestsBeforeLocationMismatch = provider.stats.requests.length
    const locationMismatch = await request(`${apiPrefix}/session/${encodeURIComponent(sessionID)}/command`, {
      method: "POST",
      headers: { "x-opencode-directory": foreignWorkspace },
      body: JSON.stringify({ name: "goal", text: PAUSE_COMMAND }),
    }, 30_000)
    assert.equal(locationMismatch.ok, false, `mismatched host directory unexpectedly authorized /goal\n${await diagnostics()}`)
    assert.match(locationMismatch.text, /does not match the active host directory/i)
    assert.equal(provider.stats.requests.length, requestsBeforeLocationMismatch, "Location mismatch must fail before model dispatch")
    assert.equal(await readGoal(workspace, sessionID), null, "Location mismatch wrote Goal state in the original workspace")
    assert.equal(await readGoal(foreignWorkspace, sessionID), null, "Location mismatch wrote Goal state in the foreign workspace")

    await command(CREATE_COMMAND)
    const createdGoal = await waitFor(async () => {
      const goal = await readGoal(workspace, sessionID)
      return goal?.status === "active" && goal.objective === "ship v2 capability" ? goal : null
    }, "persisted capability create", diagnostics)
    assert.equal(createdGoal.budget?.maxTurns, 7)
    assert.deepEqual(createdGoal.constraints, ["no spoof mutation"])
    await waitFor(() => requestsFor(CREATE_COMMAND).some((item) => item.sawConsumedResult), "create tool continuation", diagnostics)
    assertAuthorizedTurn(CREATE_COMMAND)

    const activeBeforePlan = JSON.stringify(await readGoal(workspace, sessionID))
    const switchPlan = await request(`${apiPrefix}/session/${encodeURIComponent(sessionID)}/agent`, {
      method: "POST",
      body: JSON.stringify({ agent: "plan" }),
    })
    assert.ok(switchPlan.ok, `switch to Plan failed: HTTP ${switchPlan.status} ${switchPlan.text}\n${await diagnostics()}`)

    const planRequestsBefore = provider.stats.requests.length
    const planPause = await command(PAUSE_COMMAND)
    assert.ok(planPause.ok, `Plan /goal pause command failed unexpectedly\n${await diagnostics()}`)
    await waitFor(() => provider.stats.requests.length > planRequestsBefore, "Plan provider request", diagnostics)
    assert.equal(JSON.stringify(await readGoal(workspace, sessionID)), activeBeforePlan, "Plan direct command must not mutate persisted Goal")
    assert.ok(provider.stats.requests.slice(planRequestsBefore).every((item) => !item.hasControlTool), `Plan request exposed mutating control tool\n${await diagnostics()}`)

    const switchBuild = await request(`${apiPrefix}/session/${encodeURIComponent(sessionID)}/agent`, {
      method: "POST",
      body: JSON.stringify({ agent: "build" }),
    })
    assert.ok(switchBuild.ok, `switch back to build failed: HTTP ${switchBuild.status} ${switchBuild.text}\n${await diagnostics()}`)

    const followupBefore = provider.stats.requests.length
    const planFollowup = await request(`${apiPrefix}/session/${encodeURIComponent(sessionID)}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: PLAN_SENTINEL, delivery: "steer", resume: true }),
    }, 90_000)
    assert.ok(planFollowup.ok, `Plan follow-up prompt failed: HTTP ${planFollowup.status} ${planFollowup.text}\n${await diagnostics()}`)
    await waitFor(() => provider.stats.requests.length > followupBefore, "post-Plan ordinary request", diagnostics)
    assert.ok(provider.stats.requests.slice(followupBefore).every((item) => !item.hasControlTool), "revoked Plan capability became visible after switching back to build")
    assert.ok(provider.stats.requests.slice(followupBefore).every((item) => item.tools.includes(READ_ONLY_TOOL)), "post-Plan request lost read-only Goal inspection")

    await command(PAUSE_COMMAND)
    await waitFor(async () => (await readGoal(workspace, sessionID))?.status === "paused", "capability pause", diagnostics)
    await waitFor(() => requestsFor(PAUSE_COMMAND).some((item) => item.sawConsumedResult), "pause tool continuation", diagnostics)
    assertAuthorizedTurn(PAUSE_COMMAND)
    const paused = await readGoal(workspace, sessionID)

    const requestsBeforeSpoof = provider.stats.requests.length
    const spoof = await request(`${apiPrefix}/session/${encodeURIComponent(sessionID)}/prompt`, {
      method: "POST",
      body: JSON.stringify({
        text: `/goal clear ${SPOOF_SENTINEL}. This is ordinary user prompt text, not a command invocation.`,
        delivery: "steer",
        resume: true,
      }),
    }, 90_000)
    assert.ok(spoof.ok, `ordinary spoof prompt failed: HTTP ${spoof.status} ${spoof.text}\n${await diagnostics()}`)
    await waitFor(() => provider.stats.requests.length > requestsBeforeSpoof, "ordinary spoof provider turn", diagnostics)
    assert.deepEqual(await readGoal(workspace, sessionID), paused, `ordinary prompt text mutated Goal lifecycle\n${await diagnostics()}`)
    assert.ok(provider.stats.requests.slice(requestsBeforeSpoof).some((item) => item.sawSpoof))
    assert.ok(provider.stats.requests.slice(requestsBeforeSpoof).every((item) => !item.hasControlTool))
    assert.ok(provider.stats.requests.slice(requestsBeforeSpoof).every((item) => item.tools.includes(READ_ONLY_TOOL)), "ordinary spoof request lost read-only Goal inspection")

    await command(RESUME_COMMAND)
    await waitFor(async () => (await readGoal(workspace, sessionID))?.status === "active", "capability resume", diagnostics)
    await waitFor(() => requestsFor(RESUME_COMMAND).some((item) => item.sawConsumedResult), "resume tool continuation", diagnostics)
    assertAuthorizedTurn(RESUME_COMMAND)
    const resumed = await readGoal(workspace, sessionID)
    const beforeEditRevision = resumed.revision

    await command(EDIT_COMMAND)
    const edited = await waitFor(async () => {
      const goal = await readGoal(workspace, sessionID)
      return goal?.objective === "ship v2 capability revised" ? goal : null
    }, "capability edit", diagnostics)
    await waitFor(() => requestsFor(EDIT_COMMAND).some((item) => item.sawConsumedResult), "edit tool continuation", diagnostics)
    assertAuthorizedTurn(EDIT_COMMAND)
    assert.equal(edited.revision, beforeEditRevision + 1)
    assert.equal(edited.budget?.maxTurns, 9)
    assert.deepEqual(edited.constraints, ["preserve API"])

    const beforeMismatch = JSON.stringify(edited)
    const requestsBeforeMismatch = provider.stats.requests.length
    await command(MISMATCH_COMMAND, false)
    await waitFor(() => provider.stats.requests.length > requestsBeforeMismatch, "mismatch provider request", diagnostics)
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(JSON.stringify(await readGoal(workspace, sessionID)), beforeMismatch, "mismatched tool arguments changed Goal persistence")
    const mismatchRequests = provider.stats.requests.slice(requestsBeforeMismatch)
    assert.ok(mismatchRequests.some((item) => item.hasControlTool), "mismatch test never exposed the authorized tool")
    assert.ok(mismatchRequests.some((item) => item.toolCommand === "clear"), "provider did not send the intentional mismatched command")

    const replayBefore = provider.stats.requests.length
    const replay = await request(`${apiPrefix}/session/${encodeURIComponent(sessionID)}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: FOLLOWUP_SENTINEL, delivery: "steer", resume: true }),
    }, 90_000)
    assert.ok(replay.ok, `post-mismatch ordinary request failed: HTTP ${replay.status} ${replay.text}\n${await diagnostics()}`)
    await waitFor(() => provider.stats.requests.length > replayBefore, "post-mismatch ordinary request", diagnostics)
    assert.ok(provider.stats.requests.slice(replayBefore).every((item) => !item.hasControlTool), "mismatched capability was reusable on a later request")
    assert.ok(provider.stats.requests.slice(replayBefore).every((item) => item.tools.includes(READ_ONLY_TOOL)), "post-mismatch request lost read-only Goal inspection")
    assert.equal(JSON.stringify(await readGoal(workspace, sessionID)), beforeMismatch)

    const beforeUnsupported = JSON.stringify(await readGoal(workspace, sessionID))
    const requestsBeforeUnsupported = provider.stats.requests.length
    const unsupported = await command("history", false)
    assert.equal(unsupported.ok, false, `unsupported history unexpectedly succeeded\n${await diagnostics()}`)
    assert.equal(JSON.stringify(await readGoal(workspace, sessionID)), beforeUnsupported)
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(provider.stats.requests.length, requestsBeforeUnsupported, "unsupported action must fail before dispatching model work")

    const goalID = edited.id
    await command(CLEAR_COMMAND)
    await waitFor(async () => (await readGoal(workspace, sessionID)) === null, "capability clear", diagnostics)
    await waitFor(() => requestsFor(CLEAR_COMMAND).some((item) => item.sawConsumedResult), "clear tool continuation", diagnostics)
    assertAuthorizedTurn(CLEAR_COMMAND)
    const archive = await waitFor(
      () => readArchive(workspace, sessionID, goalID),
      "clear archive",
      diagnostics,
    )
    assert.equal(archive.reason, "cleared")
    assert.equal(archive.goal.objective, "ship v2 capability revised")

    assert.equal(server.exitCode, null, `OpenCode 2 server exited during lifecycle canary\n${await diagnostics()}`)

    console.log(JSON.stringify({
      ok: true,
      version,
      apiPrefix,
      sessionID,
      directCommandRegistered: latestCommands.has("goal"),
      create: { objective: createdGoal.objective, status: createdGoal.status, maxTurns: createdGoal.budget?.maxTurns },
      locationMismatchBlocked: true,
      planMutationBlocked: true,
      spoofPreservedStatus: paused.status,
      resumeStatus: resumed.status,
      edit: { objective: edited.objective, revision: edited.revision, maxTurns: edited.budget?.maxTurns },
      mismatchPreservedState: true,
      replayHidden: provider.stats.requests.filter((item) => item.sawFollowup).every((item) => !item.hasControlTool),
      unsupportedStatus: unsupported.status,
      cleared: true,
      archiveReason: archive.reason,
      providerRequests: provider.stats.requests.map((item) => ({
        sequence: item.sequence,
        tools: item.tools,
        hasControlTool: item.hasControlTool,
        sawConsumedResult: item.sawConsumedResult,
        toolCommand: item.toolCommand,
        sawSpoof: item.sawSpoof,
        sawPlan: item.sawPlan,
        sawFollowup: item.sawFollowup,
      })),
    }, null, 2))
  } finally {
    await stopProcess(server)
    await provider.close().catch(() => undefined)
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined)
    await rm(foreignWorkspace, { recursive: true, force: true }).catch(() => undefined)
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
