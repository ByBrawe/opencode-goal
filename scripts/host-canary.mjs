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

function appendLog(current, chunk, limit = 40_000) {
  return (current + String(chunk)).slice(-limit)
}

async function seedConfigDependencies(dir) {
  await mkdir(path.join(dir, "node_modules"), { recursive: true })
  const dependencies = { "@opencode-ai/plugin": "*" }
  await writeFile(path.join(dir, "package.json"), `${JSON.stringify({ private: true, dependencies }, null, 2)}\n`)
  await writeFile(
    path.join(dir, "package-lock.json"),
    `${JSON.stringify({
      name: "opencode-goal-canary-config",
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
    child.once("close", () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function startProvider() {
  const stats = { chatRequests: 0, paths: [] }
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
    const id = `chatcmpl-canary-${stats.chatRequests}`
    const created = Math.floor(Date.now() / 1000)
    const content = "CANARY_OK"

    if (body.stream) {
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
        usage: { prompt_tokens: 32, completion_tokens: 2, total_tokens: 34 },
      })
      res.end("data: [DONE]\n\n")
      return
    }

    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({
      id,
      object: "chat.completion",
      created,
      model: "canary",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 32, completion_tokens: 2, total_tokens: 34 },
    }))
  })

  return {
    stats,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", resolve)
      })
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("failed to start deterministic provider")
      return address.port
    },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
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

async function waitForGoal(workspace, predicate, description, diagnostics, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await readGoal(workspace)
    if (last && predicate(last)) return last
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for ${description}. Last state: ${JSON.stringify(last, null, 2)}\n${diagnostics()}`)
}

async function waitForNoGoal(workspace, diagnostics, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await goalFile(workspace))) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`goal state still exists after clear\n${diagnostics()}`)
}

async function main() {
  const provider = startProvider()
  const providerPort = await provider.listen()
  const workspace = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-host-canary-"))
  const home = path.join(workspace, ".home")
  const projectConfig = path.join(workspace, ".opencode")
  const globalConfig = path.join(home, ".config", "opencode")
  const pluginDir = path.join(projectConfig, "plugins")

  await mkdir(pluginDir, { recursive: true })
  await seedConfigDependencies(projectConfig)
  await seedConfigDependencies(globalConfig)

  const pluginEntry = pathToFileURL(path.join(repoRoot, "dist", "index.js")).href
  await writeFile(path.join(pluginDir, "opencode-goal.js"), `export { default as OpenCodeGoalPlugin } from ${JSON.stringify(pluginEntry)}\n`)
  await writeFile(path.join(workspace, "README.md"), "# Host canary\n")
  await writeFile(path.join(workspace, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "canary/canary",
    small_model: "canary/canary",
    provider: {
      canary: {
        npm: "@ai-sdk/openai-compatible",
        name: "Deterministic Canary",
        options: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "canary-key" },
        models: { canary: { name: "Deterministic Canary", limit: { context: 100000, output: 4096 } } },
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
  console.log("canary: OpenCode config/dependency prewarm completed")

  const port = await reservePort()
  const server = spawnOpenCode(["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: workspace, env })
  let serverLog = ""
  server.stdout?.on("data", (chunk) => { serverLog = appendLog(serverLog, chunk) })
  server.stderr?.on("data", (chunk) => { serverLog = appendLog(serverLog, chunk) })

  const baseURL = `http://127.0.0.1:${port}`
  const directoryQuery = `directory=${encodeURIComponent(workspace)}`
  const diagnostics = () => `provider=${JSON.stringify(provider.stats)}\nserver log:\n${serverLog}`

  const api = async (pathname, init = {}) => {
    const separator = pathname.includes("?") ? "&" : "?"
    const scoped = `${pathname}${separator}${directoryQuery}`
    try {
      const response = await fetch(`${baseURL}${scoped}`, {
        ...init,
        headers: { "content-type": "application/json", ...(init.headers ?? {}) },
        signal: init.signal ?? AbortSignal.timeout(15_000),
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
    console.log("canary: real OpenCode server is ready")

    const sessionsBefore = await api("/session", { method: "GET", signal: AbortSignal.timeout(15_000) })
    assert.ok(Array.isArray(sessionsBefore?.data ?? sessionsBefore), "GET /session bootstrap probe did not return a session array")
    console.log("canary: instance bootstrap probe succeeded")

    const createdPayload = await api("/session", {
      method: "POST",
      body: JSON.stringify({ title: "opencode-goal host canary" }),
    })
    const session = createdPayload?.data ?? createdPayload
    const sessionID = String(session?.id ?? "")
    assert.ok(sessionID, `OpenCode did not create a session: ${JSON.stringify(createdPayload)}`)
    console.log(`canary: created real OpenCode session ${sessionID}`)

    const startCommand = (argumentsText) => {
      const controller = new AbortController()
      const promise = api(`/session/${encodeURIComponent(sessionID)}/command`, {
        method: "POST",
        body: JSON.stringify({ agent: "build", model: "canary/canary", command: "goal", arguments: argumentsText }),
        signal: controller.signal,
      }).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }))
      return { controller, promise }
    }

    const settle = async (started, label) => {
      const result = await Promise.race([started.promise, new Promise((resolve) => setTimeout(() => resolve(null), 2_000))])
      if (result === null) {
        started.controller.abort()
        await started.promise
        console.log(`canary: ${label} request remained open after target state; client request aborted`)
        return
      }
      if (!result.ok) throw result.error
      console.log(`canary: ${label} request completed`)
    }

    const createRequest = startCommand("ship canary --max-turns 8")
    const created = await waitForGoal(
      workspace,
      (state) => state.sessionID === sessionID && state.objective === "ship canary" && state.status === "paused" && state.stalledTurns >= 3,
      "create + idle continuation + no-progress pause",
      diagnostics,
    ).catch(async (error) => {
      createRequest.controller.abort()
      await createRequest.promise
      throw error
    })
    await settle(createRequest, "create")
    assert.equal(created.revision, 1)
    assert.ok(created.usage.turns >= 1)
    const afterCreate = provider.stats.chatRequests
    assert.ok(afterCreate >= 3, `expected initial turn plus continuations, got ${afterCreate}`)

    const editRequest = startCommand("edit ship canary v2")
    const edited = await waitForGoal(
      workspace,
      (state) => state.sessionID === sessionID && state.revision === 2 && state.objective === "ship canary v2" && state.status === "paused" && state.stalledTurns >= 3,
      "edit + renewed continuation lifecycle",
      diagnostics,
    ).catch(async (error) => {
      editRequest.controller.abort()
      await editRequest.promise
      throw error
    })
    await settle(editRequest, "edit")
    assert.ok(provider.stats.chatRequests > afterCreate)

    const clearRequest = startCommand("clear")
    await waitForNoGoal(workspace, diagnostics).catch(async (error) => {
      clearRequest.controller.abort()
      await clearRequest.promise
      throw error
    })
    await settle(clearRequest, "clear")

    console.log(JSON.stringify({
      ok: true,
      platform: process.platform,
      sessionID,
      providerRequests: provider.stats.chatRequests,
      providerPaths: [...new Set(provider.stats.paths)],
      createState: { status: created.status, stalledTurns: created.stalledTurns, turns: created.usage.turns },
      editState: { status: edited.status, revision: edited.revision, objective: edited.objective },
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
