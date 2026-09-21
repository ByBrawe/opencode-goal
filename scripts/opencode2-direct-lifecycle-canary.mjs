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

function toolNames(body) {
  if (Array.isArray(body?.tools)) {
    return body.tools
      .map((item) => item?.function?.name ?? item?.name)
      .filter((name) => typeof name === "string")
  }
  if (body?.tools && typeof body.tools === "object") return Object.keys(body.tools)
  return []
}

function streamText(res, sequence) {
  const id = `chatcmpl-goal-v2-direct-${sequence}`
  const created = Math.floor(Date.now() / 1000)
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  const send = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`)
  send({
    id,
    object: "chat.completion.chunk",
    created,
    model: "canary",
    choices: [{ index: 0, delta: { role: "assistant", content: `DIRECT_LIFECYCLE_PROVIDER_${sequence}` }, finish_reason: null }],
  })
  send({
    id,
    object: "chat.completion.chunk",
    created,
    model: "canary",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 },
  })
  res.end("data: [DONE]\n\n")
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
    stats.requests.push({
      sequence,
      text: messageText(body).slice(-7000),
      tools: toolNames(body),
    })
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
  const home = path.join(workspace, ".home")
  const pluginDir = path.join(workspace, ".opencode", "plugins")
  const bridge = path.join(pluginDir, "opencode-goal-server.js")
  const provider = startProvider()
  const providerPort = await provider.listen()

  let server
  let serverLog = ""
  let apiPrefix = null
  let sessionID = ""
  let planSessionID = ""
  let latestCommands = new Set()

  await Promise.all([
    mkdir(pluginDir, { recursive: true }),
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

  execFileSync("git", ["init", "--quiet", workspace], { stdio: "ignore" })
  execFileSync("git", ["-C", workspace, "config", "user.email", "opencode-goal-ci@example.invalid"], { stdio: "ignore" })
  execFileSync("git", ["-C", workspace, "config", "user.name", "OpenCode Goal CI"], { stdio: "ignore" })
  execFileSync("git", ["-C", workspace, "add", "."], { stdio: "ignore" })
  execFileSync("git", ["-C", workspace, "commit", "--quiet", "-m", "init"], { stdio: "ignore" })

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
      `planSessionID=${planSessionID || "none"}`,
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

    const commandFor = async (targetSessionID, text, expectOK = true) => {
      const response = await request(`${apiPrefix}/session/${encodeURIComponent(targetSessionID)}/command`, {
        method: "POST",
        body: JSON.stringify({ name: "goal", text, delivery: "steer" }),
      }, 90_000)
      if (expectOK) assert.ok(response.ok, `/goal ${text} failed: HTTP ${response.status} ${response.text}\n${await diagnostics()}`)
      return response
    }
    const command = (text, expectOK = true) => commandFor(sessionID, text, expectOK)

    await command('ship v2 preview --accept "preview persists" --constraint "no spoof mutation" --max-turns 7')
    const createdGoal = await waitFor(async () => {
      const goal = await readGoal(workspace, sessionID)
      return goal?.status === "active" && goal.objective === "ship v2 preview" ? goal : null
    }, "persisted direct create", diagnostics)
    assert.equal(createdGoal.budget?.maxTurns, 7)
    assert.deepEqual(createdGoal.constraints, ["no spoof mutation"])
    await waitFor(() => provider.stats.requests.length >= 1, "create continuation provider request", diagnostics)
    assert.ok(!provider.stats.requests[0].tools.includes(CONTROL_TOOL), `mutating control tool leaked into provider request\n${await diagnostics()}`)

    const requestsAfterCreate = provider.stats.requests.length
    const statusSnapshot = JSON.stringify(await readGoal(workspace, sessionID))
    await command("status")
    await waitFor(
      () => provider.stats.requests.length > requestsAfterCreate,
      "direct status relay provider request",
      diagnostics,
    )
    assert.equal(JSON.stringify(await readGoal(workspace, sessionID)), statusSnapshot, "status must not mutate Goal state")
    const requestsAfterStatus = provider.stats.requests.length

    await command("pause")
    await waitFor(async () => (await readGoal(workspace, sessionID))?.status === "paused", "direct pause", diagnostics)
    const paused = await readGoal(workspace, sessionID)
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(provider.stats.requests.length, requestsAfterStatus, "pause must not dispatch model work")
    const requestsBeforeSpoof = provider.stats.requests.length

    const spoof = await request(`${apiPrefix}/session/${encodeURIComponent(sessionID)}/prompt`, {
      method: "POST",
      body: JSON.stringify({
        text: "/goal clear SPOOF_DIRECT_COMMAND. This is ordinary user prompt text, not a command invocation.",
        delivery: "steer",
        resume: true,
      }),
    }, 90_000)
    assert.ok(spoof.ok, `ordinary spoof prompt failed: HTTP ${spoof.status} ${spoof.text}\n${await diagnostics()}`)
    await waitFor(() => provider.stats.requests.length > requestsBeforeSpoof, "ordinary spoof provider turn", diagnostics)
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.deepEqual(await readGoal(workspace, sessionID), paused, `ordinary prompt text mutated Goal lifecycle\n${await diagnostics()}`)
    assert.ok(provider.stats.requests.slice(requestsBeforeSpoof).some((item) => item.text.includes("SPOOF_DIRECT_COMMAND")))
    assert.ok(provider.stats.requests.slice(requestsBeforeSpoof).every((item) => !item.tools.includes(CONTROL_TOOL)))

    const requestsBeforeResume = provider.stats.requests.length
    await command("resume")
    await waitFor(async () => (await readGoal(workspace, sessionID))?.status === "active", "direct resume", diagnostics)
    await waitFor(
      () => provider.stats.requests.length > requestsBeforeResume,
      "resume continuation provider request",
      diagnostics,
    )
    const resumed = await readGoal(workspace, sessionID)
    const beforeEditRevision = resumed.revision

    const requestsBeforeEdit = provider.stats.requests.length
    await command('edit ship v2 preview revised --constraint "preserve API" --max-turns 9')
    const edited = await waitFor(async () => {
      const goal = await readGoal(workspace, sessionID)
      return goal?.objective === "ship v2 preview revised" ? goal : null
    }, "direct edit", diagnostics)
    assert.equal(edited.revision, beforeEditRevision + 1)
    assert.equal(edited.budget?.maxTurns, 9)
    assert.deepEqual(edited.constraints, ["preserve API"])
    await waitFor(
      () => provider.stats.requests.length > requestsBeforeEdit,
      "edit continuation provider request",
      diagnostics,
    )

    const beforeUnsupported = JSON.stringify(edited)
    const requestsBeforeUnsupported = provider.stats.requests.length
    const unsupported = await command("history", false)
    assert.equal(unsupported.ok, false, `unsupported history unexpectedly succeeded\n${await diagnostics()}`)
    assert.equal(JSON.stringify(await readGoal(workspace, sessionID)), beforeUnsupported)
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(provider.stats.requests.length, requestsBeforeUnsupported, "unsupported action must fail before dispatching model work")

    const goalID = edited.id
    const requestsBeforeClear = provider.stats.requests.length
    await command("clear")
    await waitFor(async () => (await readGoal(workspace, sessionID)) === null, "direct clear", diagnostics)
    const archive = await waitFor(
      () => readArchive(workspace, sessionID, goalID),
      "clear archive",
      diagnostics,
    )
    assert.equal(archive.reason, "cleared")
    assert.equal(archive.goal.objective, "ship v2 preview revised")
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(provider.stats.requests.length, requestsBeforeClear, "clear must not dispatch model work")

    const planCreated = await request(`${apiPrefix}/session`, {
      method: "POST",
      body: JSON.stringify({ title: "OpenCode Goal V2 Plan boundary" }),
    })
    assert.ok(planCreated.ok, `Plan session create failed: HTTP ${planCreated.status} ${planCreated.text}\n${await diagnostics()}`)
    planSessionID = String((planCreated.body?.data ?? planCreated.body)?.id ?? "")
    assert.ok(planSessionID, `Plan session ID missing: ${planCreated.text}`)

    const switchPlan = await request(`${apiPrefix}/session/${encodeURIComponent(planSessionID)}/agent`, {
      method: "POST",
      body: JSON.stringify({ agent: "plan" }),
    })
    assert.ok(switchPlan.ok, `switch to Plan failed: HTTP ${switchPlan.status} ${switchPlan.text}\n${await diagnostics()}`)

    const requestsBeforePlanCreate = provider.stats.requests.length
    await commandFor(planSessionID, "plan implementation safely")
    const planGoal = await waitFor(async () => {
      const goal = await readGoal(workspace, planSessionID)
      return goal?.status === "paused" ? goal : null
    }, "Plan create persisted paused", diagnostics)
    assert.equal(planGoal.execution?.agent, "plan")
    assert.match(planGoal.stopReason ?? "", /restricted agent "plan"/i)
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(
      provider.stats.requests.length,
      requestsBeforePlanCreate,
      "Plan create must not dispatch an implementation provider turn",
    )

    const switchBuild = await request(`${apiPrefix}/session/${encodeURIComponent(planSessionID)}/agent`, {
      method: "POST",
      body: JSON.stringify({ agent: "build" }),
    })
    assert.ok(switchBuild.ok, `switch to Build failed: HTTP ${switchBuild.status} ${switchBuild.text}\n${await diagnostics()}`)
    const requestsBeforePlanResume = provider.stats.requests.length
    await commandFor(planSessionID, "resume")
    const buildGoal = await waitFor(async () => {
      const goal = await readGoal(workspace, planSessionID)
      return goal?.status === "active" && goal.execution?.agent === "build" ? goal : null
    }, "Build resume repins execution", diagnostics)
    await waitFor(
      () => provider.stats.requests.length > requestsBeforePlanResume,
      "Build resume continuation provider request",
      diagnostics,
    )
    assert.equal(buildGoal.execution?.agent, "build")
    await commandFor(planSessionID, "clear")
    await waitFor(async () => (await readGoal(workspace, planSessionID)) === null, "Plan test clear", diagnostics)

    assert.equal(server.exitCode, null, `OpenCode 2 server exited during lifecycle canary\n${await diagnostics()}`)

    console.log(JSON.stringify({
      ok: true,
      version,
      apiPrefix,
      sessionID,
      planSessionID,
      directCommandRegistered: latestCommands.has("goal"),
      create: { objective: createdGoal.objective, status: createdGoal.status, maxTurns: createdGoal.budget?.maxTurns },
      spoofPreservedStatus: paused.status,
      resumeStatus: resumed.status,
      edit: { objective: edited.objective, revision: edited.revision, maxTurns: edited.budget?.maxTurns },
      unsupportedStatus: unsupported.status,
      cleared: true,
      archiveReason: archive.reason,
      planBoundary: { status: planGoal.status, agent: planGoal.execution?.agent },
      buildResume: { status: buildGoal.status, agent: buildGoal.execution?.agent },
      providerRequests: provider.stats.requests.map((item) => ({
        sequence: item.sequence,
        tools: item.tools,
        sawSpoof: item.text.includes("SPOOF_DIRECT_COMMAND"),
      })),
      mutatingControlVisible: provider.stats.requests.some((item) => item.tools.includes(CONTROL_TOOL)),
    }, null, 2))
  } finally {
    await stopProcess(server)
    await provider.close().catch(() => undefined)
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined)
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
