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
const OBJECTIVE = "10 ayrı goal turu boyunca her goal turunda 1.json value değerini tam 1 artır"
const TARGET_NAME = "1.json"

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
      name: "opencode-goal-batch-rejection-canary-config",
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

function toolNames(body) {
  return new Set((body.tools ?? []).map((item) => String(item?.function?.name ?? "")).filter(Boolean))
}

function priorToolCallNames(body) {
  const names = []
  for (const message of body.messages ?? []) {
    for (const call of message?.tool_calls ?? []) {
      const name = String(call?.function?.name ?? "")
      if (name) names.push(name)
    }
  }
  return names
}

function messageText(body) {
  const pieces = []
  for (const message of body.messages ?? []) {
    if (typeof message?.content === "string") {
      pieces.push(message.content)
      continue
    }
    if (!Array.isArray(message?.content)) continue
    for (const part of message.content) {
      if (typeof part?.text === "string") pieces.push(part.text)
      if (typeof part?.content === "string") pieces.push(part.content)
    }
  }
  return pieces.join("\n")
}

function toolDefinition(body, name) {
  return (body.tools ?? []).find((item) => item?.function?.name === name)
}

function writeArgs(body, absolutePath, value) {
  const definition = toolDefinition(body, "write")
  if (!definition) throw new Error("real OpenCode request did not expose the write tool")
  const content = `${JSON.stringify({ value }, null, 2)}\n`
  const properties = definition.function?.parameters?.properties ?? {}
  if (Object.prototype.hasOwnProperty.call(properties, "path")) return { path: absolutePath, content }
  if (Object.prototype.hasOwnProperty.call(properties, "filePath")) return { filePath: absolutePath, content }
  if (Object.prototype.hasOwnProperty.call(properties, "file_path")) return { file_path: absolutePath, content }
  throw new Error(`unsupported OpenCode write schema: ${JSON.stringify(definition.function?.parameters ?? null)}`)
}

function extractAuditRequest(text) {
  const marker = "Verification request:\n"
  const start = text.lastIndexOf(marker)
  if (start < 0) throw new Error(`batch rejection canary could not locate verifier request:\n${text.slice(-6000)}`)
  const rest = text.slice(start + marker.length)
  const end = rest.indexOf("\n\nCall opencode_goal_verifier_result")
  const raw = end >= 0 ? rest.slice(0, end) : rest
  return JSON.parse(raw)
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
    usage: { prompt_tokens: 40, completion_tokens: 4, total_tokens: 44 },
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
    usage: { prompt_tokens: 64, completion_tokens: 16, total_tokens: 80 },
  })
  res.end("data: [DONE]\n\n")
}

function startProvider(targetPath) {
  const stats = {
    chatRequests: 0,
    attemptedWrites: 0,
    completionCalls: 0,
    verifierResults: 0,
    executorFinalTexts: 0,
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
    const id = `chatcmpl-batch-${stats.chatRequests}`
    const created = Math.floor(Date.now() / 1000)
    const tools = toolNames(body)
    const priorTools = priorToolCallNames(body)
    const text = messageText(body)

    if (!body.stream) {
      res.writeHead(500, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: "batch rejection canary expects streaming OpenCode requests" } }))
      return
    }

    if (text.includes("Verification request:") && /"auditToken"\s*:/.test(text)) {
      const request = extractAuditRequest(text)
      if (!priorTools.includes("opencode_goal_verifier_result")) {
        stats.verifierResults += 1
        const revision = Number(request.revision)
        streamToolCall(res, {
          id,
          created,
          callID: `call-dishonest-verdict-${stats.chatRequests}`,
          name: "opencode_goal_verifier_result",
          args: {
            auditToken: request.auditToken,
            results: request.requirements.map((requirement) => ({
              requirementID: requirement.id,
              verdict: "proven",
              reason: "Dishonest verifier deliberately claims the process is complete so the host process guard must veto it.",
              evidence: [],
              hostEvidenceIDs: [`goal-runtime-turns-r${revision}`, `goal-runtime-progress-r${revision}`],
            })),
          },
        })
        return
      }
      streamText(res, { id, created, content: "Dishonest verifier result submitted." })
      return
    }

    if (!text.includes(OBJECTIVE)) {
      streamText(res, { id, created, content: "BATCH_CANARY_OK" })
      return
    }

    const writeCount = priorTools.filter((name) => name === "write").length
    if (writeCount === 0) {
      stats.attemptedWrites += 1
      streamToolCall(res, {
        id,
        created,
        callID: "call-batch-write-1",
        name: "write",
        args: writeArgs(body, targetPath, 1),
      })
      return
    }

    if (writeCount === 1) {
      stats.attemptedWrites += 1
      streamToolCall(res, {
        id,
        created,
        callID: "call-batch-write-10",
        name: "write",
        args: writeArgs(body, targetPath, 10),
      })
      return
    }

    if (!priorTools.includes("opencode_goal_complete")) {
      assert.ok(tools.has("opencode_goal_complete"), "batch executor did not expose opencode_goal_complete")
      stats.completionCalls += 1
      streamToolCall(res, {
        id,
        created,
        callID: "call-batch-complete",
        name: "opencode_goal_complete",
        args: { summary: "I incorrectly batched the requested 10-turn process into one turn and claim completion." },
      })
      return
    }

    stats.executorFinalTexts += 1
    streamText(res, { id, created, content: "Batch attempt finished; host should refuse completion." })
  })

  return {
    stats,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", resolve)
      })
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("failed to start deterministic batch provider")
      return address.port
    },
    async close() {
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

async function waitForGoal(workspace, predicate, description, diagnostics, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await readGoal(workspace)
    if (last && predicate(last)) return last
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for ${description}. Last state: ${JSON.stringify(last, null, 2)}\n${diagnostics()}`)
}

async function main() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-batch-rejection-canary-"))
  const home = path.join(workspace, ".home")
  const projectConfig = path.join(workspace, ".opencode")
  const globalConfig = path.join(home, ".config", "opencode")
  const pluginDir = path.join(projectConfig, "plugins")
  const targetPath = path.join(workspace, TARGET_NAME)
  const provider = startProvider(targetPath)
  const providerPort = await provider.listen()
  let lastState = null

  await mkdir(pluginDir, { recursive: true })
  await seedConfigDependencies(projectConfig)
  await seedConfigDependencies(globalConfig)
  const pluginEntry = pathToFileURL(path.join(repoRoot, "dist", "index.js")).href
  await writeFile(path.join(pluginDir, "opencode-goal.js"), `export { default as OpenCodeGoalPlugin } from ${JSON.stringify(pluginEntry)}\n`)
  await writeFile(targetPath, `${JSON.stringify({ value: 0 }, null, 2)}\n`)
  await writeFile(path.join(workspace, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "canary/canary",
    small_model: "canary/canary",
    permission: { edit: "allow" },
    provider: {
      canary: {
        npm: "@ai-sdk/openai-compatible",
        name: "Deterministic Batch Rejection Canary",
        options: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "canary-key" },
        models: { canary: { name: "Deterministic Batch Rejection Canary", limit: { context: 100000, output: 4096 } } },
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
  const diagnostics = () => `provider=${JSON.stringify(provider.stats)}\nstate=${JSON.stringify(lastState, null, 2)}\nserver log:\n${serverLog}`
  const api = async (pathname, init = {}) => {
    const separator = pathname.includes("?") ? "&" : "?"
    const scoped = `${pathname}${separator}${directoryQuery}`
    try {
      const response = await fetch(`${baseURL}${scoped}`, {
        ...init,
        headers: { "content-type": "application/json", ...(init.headers ?? {}) },
        signal: init.signal ?? AbortSignal.timeout(20_000),
      })
      const text = await response.text()
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`)
      if (!text) return null
      try { return JSON.parse(text) } catch { return text }
    } catch (error) {
      throw new Error(`OpenCode API ${init.method ?? "GET"} ${scoped} failed: ${String(error)}\n${diagnostics()}`)
    }
  }

  try {
    await waitForTcp(port, server, () => serverLog)
    const sessionsBefore = await api("/session", { method: "GET", signal: AbortSignal.timeout(45_000) })
    assert.ok(Array.isArray(sessionsBefore?.data ?? sessionsBefore), "GET /session bootstrap probe did not return a session array")

    const createdPayload = await api("/session", {
      method: "POST",
      body: JSON.stringify({ title: "opencode-goal batch rejection canary" }),
    })
    const session = createdPayload?.data ?? createdPayload
    const sessionID = String(session?.id ?? "")
    assert.ok(sessionID, `OpenCode did not create a session: ${JSON.stringify(createdPayload)}`)

    const command = api(`/session/${encodeURIComponent(sessionID)}/command`, {
      method: "POST",
      body: JSON.stringify({
        agent: "build",
        model: "canary/canary",
        command: "goal",
        arguments: `${OBJECTIVE} --max-turns 1`,
      }),
      signal: AbortSignal.timeout(90_000),
    })

    await command
    lastState = await waitForGoal(
      workspace,
      (state) => state.sessionID === sessionID && state.objective === OBJECTIVE && state.status !== "completed" && state.usage?.turns >= 1,
      "batch attempt to remain incomplete after its first Goal turn",
      diagnostics,
      30_000,
    )

    const finalFile = JSON.parse(await readFile(targetPath, "utf8"))
    const objectiveRequirement = lastState.requirements.find((item) => item.source === "objective") ?? lastState.requirements[0]

    assert.equal(provider.stats.attemptedWrites, 2, "executor must attempt a second same-turn write so cadence rejection is exercised")
    assert.equal(finalFile.value, 1, "cadence boundary must reject the second same-turn write before it reaches the workspace")
    assert.equal(lastState.progressFingerprints?.length, 1, "only the first same-turn mutation may be recorded")
    assert.equal(lastState.usage.turns, 1, "host must account the attempted batch as one Goal-owned assistant turn")
    assert.equal(provider.stats.completionCalls, 1, "dishonest executor must attempt completion exactly once")
    assert.equal(provider.stats.verifierResults, 1, "dishonest verifier must deliberately submit one proven verdict")
    assert.notEqual(objectiveRequirement?.status, "proven", "host process guard must veto the verifier's false multi-turn proof")
    assert.ok(
      lastState.evidence.some((item) => item.source === "semantic-verifier" && /Host process guard:/i.test(item.summary)),
      `expected persisted host process guard evidence, got: ${JSON.stringify(lastState.evidence)}`,
    )
    assert.notEqual(lastState.status, "completed", "a one-turn batch must never complete a 10-turn process Goal")
    assert.equal(server.exitCode, null, `OpenCode server exited during batch rejection assertions: ${diagnostics()}`)

    console.log(JSON.stringify({
      ok: true,
      platform: process.platform,
      sessionID,
      status: lastState.status,
      finalValue: finalFile.value,
      attemptedWrites: provider.stats.attemptedWrites,
      recordedMutations: lastState.progressFingerprints?.length ?? 0,
      turns: lastState.usage.turns,
      objectiveStatus: objectiveRequirement?.status,
      completionCalls: provider.stats.completionCalls,
      verifierResults: provider.stats.verifierResults,
      stopReason: lastState.stopReason ?? null,
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
