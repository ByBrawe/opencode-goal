import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { createServer } from "node:http"
import net from "node:net"
import { spawn } from "node:child_process"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const isWindows = process.platform === "win32"
const OBJECTIVE = "real host shell progress canary"
const MODE = process.env.OPENCODE_GOAL_SHELL_CANARY_MODE === "repeated" ? "repeated" : "distinct"
const REPEATED_SHELL_COMMAND = `node -e "process.stdout.write('SHELL_REPEAT')"`
const SHELL_COMMANDS = MODE === "repeated"
  ? Array.from({ length: 4 }, () => REPEATED_SHELL_COMMAND)
  : [
      `node -e "process.stdout.write('SHELL_PROGRESS_1')"`,
      `node -e "process.stdout.write('SHELL_PROGRESS_2')"`,
      `node -e "process.stdout.write('SHELL_PROGRESS_3')"`,
    ]
const EXPECT_PAUSE = MODE === "repeated"

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

function appendLog(current, chunk, limit = 60_000) {
  return (current + String(chunk)).slice(-limit)
}

async function seedConfigDependencies(dir) {
  await mkdir(path.join(dir, "node_modules"), { recursive: true })
  const dependencies = { "@opencode-ai/plugin": "*" }
  await writeFile(path.join(dir, "package.json"), `${JSON.stringify({ private: true, dependencies }, null, 2)}\n`)
  await writeFile(
    path.join(dir, "package-lock.json"),
    `${JSON.stringify({
      name: "opencode-goal-shell-progress-canary-config",
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
      if (code !== 0) {
        finish(reject, new Error(`OpenCode command exited ${code}: ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
        return
      }
      finish(resolve, { stdout, stderr })
    })
  })
}

function contentText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((part) => typeof part?.text === "string" ? part.text : typeof part?.content === "string" ? part.content : "").join("\n")
}

function allMessageText(body) {
  return (body.messages ?? []).map((message) => contentText(message?.content)).join("\n")
}

function toolDefinition(body, name) {
  return (body.tools ?? []).find((item) => item?.function?.name === name)
}

function bashArgs(body, command) {
  const definition = toolDefinition(body, "bash")
  if (!definition) throw new Error("real OpenCode request did not expose the bash tool")
  const properties = definition.function?.parameters?.properties ?? {}
  if (!Object.prototype.hasOwnProperty.call(properties, "command")) {
    throw new Error(`unsupported OpenCode bash schema: ${JSON.stringify(definition.function?.parameters ?? null)}`)
  }
  return { command }
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
    usage: { prompt_tokens: 32, completion_tokens: 3, total_tokens: 35 },
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
    usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
  })
  res.end("data: [DONE]\n\n")
}

function startProvider() {
  const stats = {
    chatRequests: 0,
    phase: "shell-0",
    shellCalls: 0,
    shellTurnsFinished: 0,
    holdStarted: 0,
    paths: [],
  }
  const held = new Set()

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
    const id = `chatcmpl-shell-progress-${stats.chatRequests}`
    const created = Math.floor(Date.now() / 1000)
    const text = allMessageText(body)
    const executorRequest = text.includes(OBJECTIVE) && Boolean(toolDefinition(body, "bash"))

    if (!executorRequest) {
      streamText(res, { id, created, content: "CANARY_OK" })
      return
    }

    const shellPhase = /^shell-(\d+)$/.exec(stats.phase)
    if (shellPhase) {
      const index = Number(shellPhase[1])
      const command = SHELL_COMMANDS[index]
      if (!command) throw new Error(`invalid shell progress canary phase: ${stats.phase}`)
      stats.phase = `shell-${index}-result`
      stats.shellCalls += 1
      streamToolCall(res, {
        id,
        created,
        callID: `call-real-shell-${index + 1}`,
        name: "bash",
        args: bashArgs(body, command),
      })
      return
    }

    const resultPhase = /^shell-(\d+)-result$/.exec(stats.phase)
    if (resultPhase) {
      const index = Number(resultPhase[1])
      stats.shellTurnsFinished += 1
      stats.phase = index + 1 < SHELL_COMMANDS.length ? `shell-${index + 1}` : "hold"
      streamText(res, { id, created, content: `REAL_SHELL_${index + 1}_DONE` })
      return
    }

    if (stats.phase === "hold") {
      stats.phase = "holding"
      stats.holdStarted += 1
      held.add(res)
      res.once("close", () => held.delete(res))
      streamHeaders(res)
      writeSse(res, {
        id,
        object: "chat.completion.chunk",
        created,
        model: "canary",
        choices: [{ index: 0, delta: { role: "assistant", content: "HOLD_AFTER_SHELL_TURNS" }, finish_reason: null }],
      })
      return
    }

    streamText(res, { id, created, content: "UNEXPECTED_EXTRA_TURN" })
  })

  return {
    stats,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", resolve)
      })
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("failed to start deterministic shell-progress provider")
      return address.port
    },
    async close() {
      for (const response of held) response.destroy()
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

async function readGoal(workspace) {
  const dir = path.join(workspace, ".opencode", "goals")
  try {
    const files = (await readdir(dir)).filter((name) => name.endsWith(".json"))
    if (!files.length) return null
    assert.equal(files.length, 1, `expected one goal state shard, found ${files.length}`)
    return JSON.parse(await readFile(path.join(dir, files[0]), "utf8"))
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}

async function waitFor(predicate, description, diagnostics, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`timed out waiting for ${description}\n${diagnostics()}`)
}

async function main() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), `opencode-goal-shell-progress-${MODE}-`))
  const home = path.join(workspace, ".home")
  const projectConfig = path.join(workspace, ".opencode")
  const globalConfig = path.join(home, ".config", "opencode")
  const pluginDir = path.join(projectConfig, "plugins")
  const provider = startProvider()
  const providerPort = await provider.listen()
  let lastState = null
  let commandTransportError = null

  await mkdir(pluginDir, { recursive: true })
  await seedConfigDependencies(projectConfig)
  await seedConfigDependencies(globalConfig)
  const pluginEntry = pathToFileURL(path.join(repoRoot, "dist", "index.js")).href
  await writeFile(path.join(pluginDir, "opencode-goal.js"), `export { default as OpenCodeGoalPlugin } from ${JSON.stringify(pluginEntry)}\n`)
  await writeFile(path.join(workspace, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "canary/canary",
    small_model: "canary/canary",
    permission: { bash: "allow", edit: "allow" },
    provider: {
      canary: {
        npm: "@ai-sdk/openai-compatible",
        name: "Deterministic Shell Progress Canary",
        options: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "canary-key" },
        models: { canary: { name: "Deterministic Shell Progress Canary", limit: { context: 100000, output: 4096 } } },
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

  const prewarm = await runOpenCode(["debug", "config"], { cwd: workspace, env, timeoutMs: 60_000 })
  assert.match(prewarm.stdout, /\{[\s\S]*\}/, `OpenCode config prewarm returned no JSON\n${prewarm.stdout}\n${prewarm.stderr}`)

  const port = await reservePort()
  const server = spawnOpenCode(["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: workspace, env })
  let serverLog = ""
  server.stdout?.on("data", (chunk) => { serverLog = appendLog(serverLog, chunk) })
  server.stderr?.on("data", (chunk) => { serverLog = appendLog(serverLog, chunk) })
  const baseURL = `http://127.0.0.1:${port}`
  const directoryQuery = `directory=${encodeURIComponent(workspace)}`
  const diagnostics = () => `mode=${MODE}\nprovider=${JSON.stringify(provider.stats)}\ncommandTransportError=${String(commandTransportError ?? "none")}\nstate=${JSON.stringify(lastState, null, 2)}\nserver log:\n${serverLog}`

  const api = async (pathname, init = {}) => {
    const separator = pathname.includes("?") ? "&" : "?"
    const scoped = `${pathname}${separator}${directoryQuery}`
    const response = await fetch(`${baseURL}${scoped}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
      signal: init.signal ?? AbortSignal.timeout(20_000),
    })
    const responseText = await response.text()
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${responseText}`)
    if (!responseText) return null
    try { return JSON.parse(responseText) } catch { return responseText }
  }

  try {
    await waitForTcp(port, server, () => serverLog)
    const sessionsBefore = await api("/session", { method: "GET", signal: AbortSignal.timeout(45_000) })
    assert.ok(Array.isArray(sessionsBefore?.data ?? sessionsBefore), "GET /session bootstrap probe did not return a session array")

    const createdPayload = await api("/session", { method: "POST", body: JSON.stringify({ title: `opencode-goal shell progress ${MODE} canary` }) })
    const session = createdPayload?.data ?? createdPayload
    const sessionID = String(session?.id ?? "")
    assert.ok(sessionID, `OpenCode did not create a session: ${JSON.stringify(createdPayload)}`)

    const command = api(`/session/${encodeURIComponent(sessionID)}/command`, {
      method: "POST",
      body: JSON.stringify({ agent: "build", model: "canary/canary", command: "goal", arguments: `${OBJECTIVE} --max-turns 8` }),
      signal: AbortSignal.timeout(75_000),
    }).catch((error) => {
      commandTransportError = error
      return null
    })

    await waitFor(
      async () => {
        lastState = await readGoal(workspace)
        const shellFingerprints = (lastState?.progressFingerprints ?? []).filter((item) => /^shell:[a-f0-9]{64}$/.test(item))
        if (EXPECT_PAUSE) {
          return provider.stats.shellCalls === SHELL_COMMANDS.length
            && provider.stats.shellTurnsFinished === SHELL_COMMANDS.length
            && lastState?.status === "paused"
            && lastState?.stalledTurns === 3
            && shellFingerprints.length === 1
        }
        return provider.stats.shellCalls === SHELL_COMMANDS.length
          && provider.stats.shellTurnsFinished === SHELL_COMMANDS.length
          && provider.stats.holdStarted === 1
          && shellFingerprints.length === SHELL_COMMANDS.length
      },
      EXPECT_PAUSE
        ? "four real repeated shell Goal turns to reach the three-turn stall guard"
        : "three real distinct shell-only Goal turns to complete without tripping the stall guard",
      diagnostics,
    )
    await new Promise((resolve) => setTimeout(resolve, 250))
    lastState = await readGoal(workspace)

    const shellFingerprints = lastState.progressFingerprints.filter((item) => /^shell:[a-f0-9]{64}$/.test(item))
    const shellNotes = lastState.progressNotes.filter((item) => item?.summary?.includes("Goal-owned shell command completed."))

    if (EXPECT_PAUSE) {
      assert.equal(lastState.status, "paused", `three repeated no-progress shell turns must pause the Goal: ${diagnostics()}`)
      assert.equal(lastState.progressRevision, 1, "only the first occurrence of an identical shell command may count as progress")
      assert.equal(lastState.observedProgressRevision, 1, "the single shell progress revision must remain settled")
      assert.equal(lastState.stalledTurns, 3, "the three deduplicated repeated turns must reach the normal stall limit")
      assert.match(lastState.stopReason ?? "", /3 continuation turns without host-observed progress/)
      assert.equal(shellFingerprints.length, 1, "repeating one shell command must persist only one shell fingerprint")
      assert.equal(shellNotes.length, 1, "repeating one shell command must persist only one shell progress note")
      assert.equal(provider.stats.holdStarted, 0, "a paused Goal must not dispatch another autonomous continuation")
    } else {
      assert.equal(lastState.status, "active", `three distinct shell-only turns must keep the Goal active: ${diagnostics()}`)
      assert.equal(lastState.progressRevision, SHELL_COMMANDS.length, `each distinct real shell turn should increment progress exactly once: ${JSON.stringify(lastState.progressFingerprints)}`)
      assert.equal(lastState.observedProgressRevision, lastState.progressRevision, "the host must settle all three shell progress revisions at turn boundaries")
      assert.equal(lastState.stalledTurns, 0, "three successful Goal-owned shell turns must keep the stall counter at zero")
      assert.equal(shellFingerprints.length, SHELL_COMMANDS.length)
      assert.equal(new Set(shellFingerprints).size, SHELL_COMMANDS.length, "three distinct shell commands must produce three distinct fingerprints")
      assert.equal(shellNotes.length, SHELL_COMMANDS.length, `expected one generic host note per shell turn: ${JSON.stringify(lastState.progressNotes)}`)
    }

    const persistedProgress = JSON.stringify({
      progressFingerprints: lastState.progressFingerprints,
      progressNotes: lastState.progressNotes,
    })
    assert.doesNotMatch(persistedProgress, /SHELL_PROGRESS_[123]|SHELL_REPEAT|process\.stdout|node -e/, "raw shell command text must not be persisted in progress state")
    assert.equal(server.exitCode, null, `OpenCode server exited during shell-progress assertions: ${diagnostics()}`)

    console.log(JSON.stringify({
      ok: true,
      mode: MODE,
      platform: process.platform,
      sessionID,
      shellCalls: provider.stats.shellCalls,
      shellTurnsFinished: provider.stats.shellTurnsFinished,
      holdStarted: provider.stats.holdStarted,
      status: lastState.status,
      progressRevision: lastState.progressRevision,
      observedProgressRevision: lastState.observedProgressRevision,
      progressFingerprints: lastState.progressFingerprints,
      stalledTurns: lastState.stalledTurns,
      stopReason: lastState.stopReason ?? null,
      commandTransportError: commandTransportError ? String(commandTransportError) : null,
    }, null, 2))

    void command
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
