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
const GOAL_PROMPT_MARKER = "Continue working toward the active OpenCode goal."
const COMPACTION_CONTEXT_MARKER = "Persistent OpenCode goal state:"
const GENERIC_CONTINUE_MARKER = "Continue if you have next steps"

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
      name: "opencode-goal-compaction-canary-config",
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

function partText(part) {
  if (typeof part === "string") return part
  if (typeof part?.text === "string") return part.text
  if (typeof part?.content === "string") return part.content
  return ""
}

function messageText(message) {
  if (typeof message?.content === "string") return message.content
  if (!Array.isArray(message?.content)) return ""
  return message.content.map(partText).filter(Boolean).join("\n")
}

function requestText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  return messages.map((message) => `${String(message?.role ?? "unknown")}: ${messageText(message)}`).join("\n")
}

function latestUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return messageText(messages[index])
  }
  return ""
}

function usageFor(mode, sequence) {
  if (mode === "auto" && sequence === 1) {
    // OpenCode 1.18.x proactively compacts when the last completed assistant
    // usage reaches its usable model input budget. The canary model below has a
    // 10k context / 2k output allowance, so this synthetic but host-observed
    // usage forces OpenCode's own overflow detector to create an auto compaction.
    return { prompt_tokens: 9_000, completion_tokens: 4, total_tokens: 9_004 }
  }
  return { prompt_tokens: 40, completion_tokens: 4, total_tokens: 44 }
}

function streamText(res, content, sequence, usage) {
  const id = `chatcmpl-compaction-canary-${sequence}`
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
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
  })
  send({
    id,
    object: "chat.completion.chunk",
    created,
    model: "canary",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage,
  })
  res.end("data: [DONE]\n\n")
}

function jsonText(res, content, sequence, usage) {
  const id = `chatcmpl-compaction-canary-${sequence}`
  res.writeHead(200, { "content-type": "application/json" })
  res.end(JSON.stringify({
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "canary",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage,
  }))
}

function startProvider({ mode, objective }) {
  let releaseFirst
  const firstRelease = new Promise((resolve) => { releaseFirst = resolve })
  const stats = { chatRequests: 0, requests: [], paths: [] }
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
    const sequence = stats.chatRequests
    const allText = requestText(body)
    const userText = latestUserText(body)
    stats.requests.push({ sequence, allText, userText })

    if (sequence === 1) await firstRelease

    const content = sequence === 2
      ? `Compaction checkpoint: preserve the active objective ${objective}; the next step is to continue the Goal normally.`
      : sequence === 3
        ? `GOAL_CONTINUATION_AFTER_${mode.toUpperCase()}_COMPACTION_OK`
        : sequence > 3
          ? `UNEXPECTED_EXTRA_REQUEST_${sequence}`
          : "INITIAL_GOAL_TURN_OK"
    const usage = usageFor(mode, sequence)

    if (body.stream) streamText(res, content, sequence, usage)
    else jsonText(res, content, sequence, usage)
  })

  return {
    stats,
    releaseFirst() { releaseFirst() },
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", resolve)
      })
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("failed to start deterministic compaction provider")
      return address.port
    },
    async close() {
      releaseFirst()
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

async function goalFile(workspace) {
  const dir = path.join(workspace, ".opencode", "goals")
  try {
    const files = (await readdir(dir)).filter((name) => name.endsWith(".json"))
    if (!files.length) return null
    assert.equal(files.length, 1, `expected one goal state shard, found ${files.length}`)
    return path.join(dir, files[0])
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}

async function readGoal(workspace) {
  const file = await goalFile(workspace)
  return file ? JSON.parse(await readFile(file, "utf8")) : null
}

async function waitFor(predicate, description, diagnostics, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`timed out waiting for ${description}\n${diagnostics()}`)
}

async function waitForGoal(workspace, predicate, description, diagnostics, timeoutMs = 45_000) {
  let latest = null
  await waitFor(async () => {
    latest = await readGoal(workspace)
    return Boolean(latest && predicate(latest))
  }, description, () => `${diagnostics()}\nlast goal=${JSON.stringify(latest, null, 2)}`, timeoutMs)
  return latest
}

function modelLimits(mode) {
  if (mode === "auto") return { context: 10_000, output: 2_048 }
  return { context: 100_000, output: 4_096 }
}

export async function runCompactionCanary({ mode }) {
  assert.ok(mode === "manual" || mode === "auto", `unsupported compaction canary mode: ${mode}`)
  const objective = mode === "auto"
    ? "prove real host automatic compaction continuation"
    : "prove real host manual compaction continuation"
  const provider = startProvider({ mode, objective })
  const providerPort = await provider.listen()
  const workspace = await mkdtemp(path.join(os.tmpdir(), `opencode-goal-real-${mode}-compaction-canary-`))
  const home = path.join(workspace, ".home")
  const projectConfig = path.join(workspace, ".opencode")
  const globalConfig = path.join(home, ".config", "opencode")
  const pluginDir = path.join(projectConfig, "plugins")
  let server
  let serverLog = ""

  await mkdir(pluginDir, { recursive: true })
  await seedConfigDependencies(projectConfig)
  await seedConfigDependencies(globalConfig)
  const pluginEntry = pathToFileURL(path.join(repoRoot, "dist", "index.js")).href
  await writeFile(path.join(pluginDir, "opencode-goal.js"), `export { default as OpenCodeGoalPlugin } from ${JSON.stringify(pluginEntry)}\n`)
  await writeFile(path.join(workspace, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "canary/canary",
    small_model: "canary/canary",
    compaction: { auto: true },
    provider: {
      canary: {
        npm: "@ai-sdk/openai-compatible",
        name: "Deterministic Compaction Canary",
        options: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "canary-key" },
        models: { canary: { name: "Deterministic Compaction Canary", limit: modelLimits(mode) } },
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

  const diagnostics = () => `mode=${mode}\nprovider=${JSON.stringify({ chatRequests: provider.stats.chatRequests, requests: provider.stats.requests.map((item) => ({ sequence: item.sequence, userText: item.userText.slice(0, 500), hasCompactionContext: item.allText.includes(COMPACTION_CONTEXT_MARKER) })) }, null, 2)}\nserver log:\n${serverLog}`

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
      const scoped = `${pathname}${separator}${directoryQuery}`
      const response = await fetch(`${baseURL}${scoped}`, {
        ...init,
        headers: { "content-type": "application/json", ...(init.headers ?? {}) },
        signal: init.signal ?? AbortSignal.timeout(45_000),
      })
      const text = await response.text()
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}\n${diagnostics()}`)
      if (!text) return null
      try { return JSON.parse(text) } catch { return text }
    }

    const sessionsBefore = await api("/session", { method: "GET" })
    assert.ok(Array.isArray(sessionsBefore?.data ?? sessionsBefore), "GET /session bootstrap did not return an array")
    const createdPayload = await api("/session", { method: "POST", body: JSON.stringify({ title: `opencode-goal ${mode} compaction canary` }) })
    const session = createdPayload?.data ?? createdPayload
    const sessionID = String(session?.id ?? "")
    assert.ok(sessionID, `OpenCode did not create a session: ${JSON.stringify(createdPayload)}`)

    const commandController = new AbortController()
    const commandPromise = api(`/session/${encodeURIComponent(sessionID)}/command`, {
      method: "POST",
      body: JSON.stringify({
        agent: "build",
        model: "canary/canary",
        command: "goal",
        arguments: `${objective} --max-turns 2`,
      }),
      signal: commandController.signal,
    }).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }))

    await waitFor(() => provider.stats.chatRequests === 1, "the first Goal-owned provider turn to enter", diagnostics)
    const activeBeforeCompaction = await waitForGoal(
      workspace,
      (goal) => goal.sessionID === sessionID && goal.status === "active" && goal.objective === objective,
      `active Goal state before ${mode} compaction`,
      diagnostics,
    )
    assert.equal(activeBeforeCompaction.usage.turns, 0, "the held first assistant turn must not be accounted before compaction admission")

    if (mode === "manual") {
      const summarizePromise = api(`/session/${encodeURIComponent(sessionID)}/summarize`, {
        method: "POST",
        body: JSON.stringify({ providerID: "canary", modelID: "canary" }),
        signal: AbortSignal.timeout(45_000),
      })
      await new Promise((resolve) => setTimeout(resolve, 250))
      provider.releaseFirst()
      const summarizeResult = await summarizePromise
      assert.ok(summarizeResult === true || summarizeResult?.data === true, `manual summarize did not succeed: ${JSON.stringify(summarizeResult)}`)
    } else {
      // No summarize API call is made. Releasing this high-usage turn must make
      // OpenCode's own overflow detector enqueue an automatic compaction.
      provider.releaseFirst()
    }

    await waitFor(() => provider.stats.chatRequests >= 3, `${mode} compaction summary plus Goal-owned continuation`, diagnostics)
    const stopped = await waitForGoal(
      workspace,
      (goal) => goal.usage.turns >= 2 && goal.status !== "active",
      "Goal to account exactly two owned assistant turns and stop at max-turns",
      diagnostics,
    )

    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(provider.stats.chatRequests, 3, `expected initial Goal turn, one ${mode} compaction request, and one Goal continuation only\n${diagnostics()}`)
    assert.equal(stopped.usage.turns, 2, "compaction summary must not count as a Goal assistant turn")
    assert.equal(stopped.budget.maxTurns, 2)
    assert.equal(stopped.status, "budget_limited")

    const first = provider.stats.requests[0]
    const compact = provider.stats.requests[1]
    const continuation = provider.stats.requests[2]
    assert.ok(first.userText.includes(GOAL_PROMPT_MARKER), `initial Goal request was not Goal-owned\n${diagnostics()}`)
    assert.ok(compact.allText.includes(COMPACTION_CONTEXT_MARKER), `${mode} compaction request did not include persisted Goal context\n${diagnostics()}`)
    assert.ok(compact.allText.includes(objective), `${mode} compaction request lost the active Goal objective\n${diagnostics()}`)
    assert.ok(continuation.userText.includes(GOAL_PROMPT_MARKER), `post-compaction request was not Goal-owned\n${diagnostics()}`)
    assert.ok(continuation.userText.includes(objective), `Goal-owned continuation lost the objective\n${diagnostics()}`)
    assert.ok(!continuation.userText.includes(GENERIC_CONTINUE_MARKER), `native generic compaction continue leaked through\n${diagnostics()}`)

    const messagePayload = await api(`/session/${encodeURIComponent(sessionID)}/message`, { method: "GET" })
    const messages = messagePayload?.data ?? messagePayload
    assert.ok(Array.isArray(messages), `session messages response was not an array: ${JSON.stringify(messagePayload)}`)
    const parts = messages.flatMap((message) => Array.isArray(message?.parts) ? message.parts : [])
    const compactionParts = parts.filter((part) => part?.type === "compaction")
    assert.ok(compactionParts.length >= 1, `session transcript did not persist a compaction part\n${diagnostics()}`)
    if (mode === "auto") {
      assert.ok(compactionParts.some((part) => part.auto === true), `automatic canary never persisted an auto compaction marker\n${diagnostics()}`)
    }
    const transcriptText = parts.map(partText).filter(Boolean).join("\n")
    assert.ok(!transcriptText.includes(GENERIC_CONTINUE_MARKER), "transcript contains OpenCode's generic post-compaction continue despite Goal ownership")

    commandController.abort()
    await commandPromise

    const result = {
      ok: true,
      mode,
      platform: process.platform,
      sessionID,
      providerRequests: provider.stats.chatRequests,
      sequence: provider.stats.requests.map((item) => ({
        sequence: item.sequence,
        goalPrompt: item.userText.includes(GOAL_PROMPT_MARKER),
        compactionContext: item.allText.includes(COMPACTION_CONTEXT_MARKER),
        genericContinue: item.userText.includes(GENERIC_CONTINUE_MARKER),
      })),
      compaction: {
        persistedParts: compactionParts.length,
        auto: compactionParts.some((part) => part.auto === true),
      },
      finalGoal: {
        status: stopped.status,
        turns: stopped.usage.turns,
        maxTurns: stopped.budget.maxTurns,
        stopReason: stopped.stopReason,
      },
    }
    console.log(JSON.stringify(result, null, 2))
    return result
  } finally {
    provider.releaseFirst()
    await stopProcess(server)
    await provider.close().catch(() => undefined)
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined)
  }
}
