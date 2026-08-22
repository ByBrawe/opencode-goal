import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { createServer } from "node:http"
import net from "node:net"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const isWindows = process.platform === "win32"
const GOAL_OBJECTIVE = "preserve Goal execution across a foreign slash command"
const GOAL_PROMPT_MARKER = "Continue working toward the active OpenCode goal."
const FOREIGN_COMMAND_BRIDGE = "FOREIGN_COMMAND_BRIDGE"
const PRIVATE_MARKER = "opencode-goal:foreign-command:"

function resolveOpenCodeBinary() {
  if (!isWindows) return path.join(repoRoot, "node_modules", ".bin", "opencode")
  const candidates = [
    path.join(repoRoot, "node_modules", "opencode-windows-x64", "bin", "opencode.exe"),
    path.join(repoRoot, "node_modules", "opencode-windows-x64-baseline", "bin", "opencode.exe"),
    path.join(repoRoot, "node_modules", "opencode-windows-arm64", "bin", "opencode.exe"),
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) throw new Error(`OpenCode native Windows binary was not installed. Checked: ${candidates.join(", ")}`)
  return found
}

const opencodeBin = resolveOpenCodeBinary()

function appendLog(current, chunk, limit = 80_000) {
  return (current + String(chunk)).slice(-limit)
}

async function seedConfigDependencies(dir) {
  await mkdir(path.join(dir, "node_modules"), { recursive: true })
  const dependencies = { "@opencode-ai/plugin": "*" }
  await writeFile(path.join(dir, "package.json"), `${JSON.stringify({ private: true, dependencies }, null, 2)}\n`)
  await writeFile(
    path.join(dir, "package-lock.json"),
    `${JSON.stringify({
      name: "opencode-goal-foreign-command-config",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { dependencies } },
    }, null, 2)}\n`,
  )
  await writeFile(path.join(dir, ".gitignore"), "node_modules\npackage.json\npackage-lock.json\nbun.lock\n.gitignore\n")
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
    if (child.exitCode !== null) throw new Error(`OpenCode server exited before ready.\n${logs()}`)
    const connected = await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port })
      socket.once("connect", () => { socket.destroy(); resolve(true) })
      socket.once("error", () => resolve(false))
      socket.setTimeout(500, () => { socket.destroy(); resolve(false) })
    })
    if (connected) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for OpenCode server on ${port}\n${logs()}`)
}

async function stopProcess(child, timeoutMs = 2_000) {
  if (!child || child.exitCode !== null) return
  child.kill()
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve()
    const timer = setTimeout(resolve, timeoutMs)
    child.once("close", () => { clearTimeout(timer); resolve() })
  })
}

function spawnOpenCode(args, options = {}) {
  return spawn(opencodeBin, args, { ...options, windowsHide: true })
}

async function runOpenCode(args, { cwd, env, timeoutMs = 60_000 }) {
  return await new Promise((resolve, reject) => {
    const child = spawnOpenCode(args, { cwd, env })
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
      finish(reject, new Error(`OpenCode command timed out: ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, timeoutMs)
    child.once("error", (error) => finish(reject, error))
    child.once("close", (code) => {
      if (code !== 0) return finish(reject, new Error(`OpenCode command exited ${code}: ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
      finish(resolve, { stdout, stderr })
    })
  })
}

function contentText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((part) => typeof part?.text === "string" ? part.text : typeof part?.content === "string" ? part.content : "").join("\n")
}

function lastUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return contentText(messages[index]?.content)
  }
  return contentText(messages.at(-1)?.content)
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

function streamText(res, content, sequence) {
  const id = `chatcmpl-foreign-command-${sequence}`
  const created = Math.floor(Date.now() / 1000)
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
    usage: { prompt_tokens: 40, completion_tokens: 4, total_tokens: 44 },
  })
  res.end("data: [DONE]\n\n")
}

function startProvider() {
  const stats = {
    chatRequests: 0,
    goalRequests: 0,
    goalClosed: 0,
    foreignRequests: 0,
    markerLeaks: 0,
    otherRequests: 0,
    lastForeignText: "",
    paths: [],
  }
  const heldGoalResponses = new Set()

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
    const text = lastUserText(body)
    stats.chatRequests += 1
    const sequence = stats.chatRequests
    if (text.includes(PRIVATE_MARKER)) stats.markerLeaks += 1

    if (text.includes(GOAL_PROMPT_MARKER) && text.includes(GOAL_OBJECTIVE)) {
      stats.goalRequests += 1
      const id = `chatcmpl-goal-held-${sequence}`
      const created = Math.floor(Date.now() / 1000)
      heldGoalResponses.add(res)
      res.once("close", () => {
        if (heldGoalResponses.delete(res)) stats.goalClosed += 1
      })
      streamHeaders(res)
      writeSse(res, {
        id,
        object: "chat.completion.chunk",
        created,
        model: "canary",
        choices: [{ index: 0, delta: { role: "assistant", content: `GOAL_HELD_${stats.goalRequests}` }, finish_reason: null }],
      })
      return
    }

    if (text.includes(FOREIGN_COMMAND_BRIDGE)) {
      stats.foreignRequests += 1
      stats.lastForeignText = text
      streamText(res, "FOREIGN_OK", sequence)
      return
    }

    stats.otherRequests += 1
    streamText(res, `OTHER_${stats.otherRequests}`, sequence)
  })

  return {
    stats,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", resolve)
      })
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("failed to start foreign-command provider")
      return address.port
    },
    async close() {
      for (const response of heldGoalResponses) response.destroy()
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

async function readGoal(workspace) {
  const dir = path.join(workspace, ".opencode", "goals")
  try {
    const files = (await readdir(dir)).filter((name) => name.endsWith(".json"))
    if (!files.length) return null
    assert.equal(files.length, 1, `expected one Goal shard, found ${files.length}`)
    return JSON.parse(await readFile(path.join(dir, files[0]), "utf8"))
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}

async function waitFor(predicate, description, diagnostics, timeoutMs = 35_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  const detail = typeof diagnostics === "function" ? await diagnostics() : diagnostics
  throw new Error(`timed out waiting for ${description}\n${detail}`)
}

async function main() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-foreign-command-"))
  const home = path.join(workspace, ".home")
  const projectConfig = path.join(workspace, ".opencode")
  const globalConfig = path.join(home, ".config", "opencode")
  const pluginDir = path.join(projectConfig, "plugins")
  const commandDir = path.join(projectConfig, "commands")
  const agentDir = path.join(projectConfig, "agents")
  const provider = startProvider()
  const providerPort = await provider.listen()
  let server
  let serverLog = ""
  let lastState = null
  let goalCommandError = null
  let foreignCommandError = null

  await mkdir(pluginDir, { recursive: true })
  await mkdir(commandDir, { recursive: true })
  await mkdir(agentDir, { recursive: true })
  await seedConfigDependencies(projectConfig)
  await seedConfigDependencies(globalConfig)

  const pluginEntry = pathToFileURL(path.join(repoRoot, "dist", "index.js")).href
  await writeFile(path.join(pluginDir, "opencode-goal.js"), `export { default as OpenCodeGoalPlugin } from ${JSON.stringify(pluginEntry)}\n`)
  await writeFile(path.join(commandDir, "foreign.md"), `---\ndescription: Foreign command ownership canary\nagent: opencode-foreign-local\n---\n\n${FOREIGN_COMMAND_BRIDGE}. Reply exactly: FOREIGN_OK.\n`)
  await writeFile(path.join(agentDir, "opencode-foreign-local.md"), `---\ndescription: Foreign command local agent\nmode: primary\npermission:\n  "*": deny\n---\n\nReply exactly: FOREIGN_OK\n`)
  await writeFile(path.join(workspace, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "canary/canary",
    small_model: "canary/canary",
    provider: {
      canary: {
        npm: "@ai-sdk/openai-compatible",
        name: "Deterministic Foreign Command Canary",
        options: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "canary-key" },
        models: { canary: { name: "Deterministic Foreign Command Canary", limit: { context: 100000, output: 4096 } } },
      },
    },
  }, null, 2)}\n`)

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DB: ":memory:",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    CI: "true",
  }

  try {
    const prewarm = await runOpenCode(["debug", "config"], { cwd: workspace, env, timeoutMs: 60_000 })
    assert.match(prewarm.stdout, /\{[\s\S]*\}/, `OpenCode config prewarm returned no JSON\n${prewarm.stdout}\n${prewarm.stderr}`)

    const port = await reservePort()
    server = spawnOpenCode(["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: workspace, env })
    server.stdout?.on("data", (chunk) => { serverLog = appendLog(serverLog, chunk) })
    server.stderr?.on("data", (chunk) => { serverLog = appendLog(serverLog, chunk) })
    await waitForTcp(port, server, () => serverLog)

    const baseURL = `http://127.0.0.1:${port}`
    const directoryQuery = `directory=${encodeURIComponent(workspace)}`
    const api = async (pathname, init = {}) => {
      const separator = pathname.includes("?") ? "&" : "?"
      const response = await fetch(`${baseURL}${pathname}${separator}${directoryQuery}`, {
        ...init,
        headers: { "content-type": "application/json", ...(init.headers ?? {}) },
        signal: init.signal ?? AbortSignal.timeout(30_000),
      })
      const text = await response.text()
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`)
      if (!text) return null
      try { return JSON.parse(text) } catch { return text }
    }
    const diagnostics = async () => {
      try { lastState = await readGoal(workspace) } catch {}
      return `provider=${JSON.stringify(provider.stats)}\ngoalCommandError=${String(goalCommandError ?? "none")}\nforeignCommandError=${String(foreignCommandError ?? "none")}\nstate=${JSON.stringify(lastState, null, 2)}\nserver log:\n${serverLog}`
    }

    const sessionsPayload = await api("/session", { method: "GET" })
    assert.ok(Array.isArray(sessionsPayload?.data ?? sessionsPayload), "GET /session bootstrap did not return an array")
    const createdPayload = await api("/session", { method: "POST", body: JSON.stringify({ title: "Goal foreign-command ownership canary" }) })
    const session = createdPayload?.data ?? createdPayload
    const sessionID = String(session?.id ?? "")
    assert.ok(sessionID, `OpenCode did not create a session: ${JSON.stringify(createdPayload)}`)

    const commandPath = `/session/${encodeURIComponent(sessionID)}/command`
    const goalController = new AbortController()
    const goalCommand = api(commandPath, {
      method: "POST",
      body: JSON.stringify({ agent: "build", model: "canary/canary", command: "goal", arguments: `${GOAL_OBJECTIVE} --max-turns 8` }),
      signal: goalController.signal,
    }).catch((error) => {
      goalCommandError = error
      return null
    })

    await waitFor(() => provider.stats.goalRequests === 1, "first Goal provider turn to be held open", diagnostics)
    await waitFor(async () => {
      lastState = await readGoal(workspace)
      return lastState?.status === "active" && lastState?.objective === GOAL_OBJECTIVE && lastState?.execution?.agent === "build"
    }, "Goal to persist its original build execution context", diagnostics)

    const beforeForeign = await readGoal(workspace)
    assert.deepEqual(beforeForeign?.execution?.model, { providerID: "canary", modelID: "canary" })

    const foreignController = new AbortController()
    const foreignCommand = api(commandPath, {
      method: "POST",
      body: JSON.stringify({ agent: "build", model: "canary/canary", command: "foreign", arguments: "" }),
      signal: foreignController.signal,
    }).catch((error) => {
      foreignCommandError = error
      return null
    })

    await waitFor(() => provider.stats.goalClosed >= 1, "host to cancel the in-flight Goal stream for the foreign slash command", diagnostics)
    await waitFor(() => provider.stats.foreignRequests === 1, "foreign slash-command bridge to execute once", diagnostics)
    await waitFor(() => provider.stats.goalRequests >= 2, "Goal to resume autonomous continuation after the foreign command", diagnostics)
    await waitFor(async () => {
      lastState = await readGoal(workspace)
      return lastState?.status === "active" && lastState?.execution?.agent === "build"
    }, "Goal to remain active under its original executor", diagnostics)

    assert.equal(provider.stats.foreignRequests, 1, `foreign command should execute exactly one compatibility model turn\n${await diagnostics()}`)
    assert.equal(provider.stats.markerLeaks, 0, `private command ownership marker must never reach the provider\n${await diagnostics()}`)
    assert.equal(provider.stats.otherRequests, 0, `no unrelated provider request should be created\n${await diagnostics()}`)
    assert.doesNotMatch(provider.stats.lastForeignText, /opencode-goal:foreign-command:/)
    assert.equal(lastState.objective, GOAL_OBJECTIVE)
    assert.equal(lastState.revision, beforeForeign.revision)
    assert.equal(lastState.status, "active")
    assert.equal(lastState.execution?.agent, "build", "foreign command local agent must not replace Goal execution ownership")
    assert.deepEqual(lastState.execution?.model, beforeForeign.execution?.model, "foreign command model context must not repin Goal execution")

    foreignController.abort()
    goalController.abort()
    await Promise.allSettled([foreignCommand, goalCommand])

    console.log(JSON.stringify({
      ok: true,
      platform: process.platform,
      sessionID,
      provider: provider.stats,
      goal: {
        id: lastState.id,
        status: lastState.status,
        revision: lastState.revision,
        execution: lastState.execution,
      },
    }, null, 2))
  } finally {
    await stopProcess(server)
    await provider.close().catch(() => undefined)
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined)
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
