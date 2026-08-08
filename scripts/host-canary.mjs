import assert from "node:assert/strict"
import { createServer } from "node:http"
import net from "node:net"
import { spawn } from "node:child_process"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const isWindows = process.platform === "win32"
const opencodeBin = path.join(repoRoot, "node_modules", ".bin", isWindows ? "opencode.cmd" : "opencode")

function ringAppend(current, chunk, limit = 40_000) {
  return (current + String(chunk)).slice(-limit)
}

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") return reject(new Error("failed to reserve TCP port"))
      const port = address.port
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

async function waitForTcp(port, child, log, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`OpenCode server exited before becoming ready.\n${log()}`)
    const connected = await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port })
      socket.once("connect", () => { socket.destroy(); resolve(true) })
      socket.once("error", () => resolve(false))
      socket.setTimeout(500, () => { socket.destroy(); resolve(false) })
    })
    if (connected) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for OpenCode server on ${port}\n${log()}`)
}

function startDeterministicProvider() {
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
      res.end(JSON.stringify({ error: { message: `unexpected canary endpoint: ${req.method} ${url.pathname}` } }))
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
  return spawn(opencodeBin, args, {
    ...options,
    shell: isWindows,
    windowsHide: true,
  })
}

async function goalStateFile(workspace) {
  const dir = path.join(workspace, ".opencode", "goals")
  try {
    const files = (await readdir(dir)).filter((name) => name.endsWith(".json"))
    if (files.length === 0) return null
    assert.equal(files.length, 1, `expected one goal state shard, found ${files.length}`)
    return path.join(dir, files[0])
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}

async function readGoalState(workspace) {
  const file = await goalStateFile(workspace)
  if (!file) return null
  return JSON.parse(await readFile(file, "utf8"))
}

async function waitForState(workspace, predicate, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await readGoalState(workspace)
    if (last && predicate(last)) return last
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for ${description}. Last state: ${JSON.stringify(last, null, 2)}`)
}

async function waitForNoGoalState(workspace, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await goalStateFile(workspace))) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("goal state still exists after /goal clear")
}

async function main() {
  const provider = startDeterministicProvider()
  const providerPort = await provider.listen()
  const workspace = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-host-canary-"))
  const home = path.join(workspace, ".home")
  const pluginDir = path.join(workspace, ".opencode", "plugins")
  await mkdir(pluginDir, { recursive: true })
  await mkdir(home, { recursive: true })

  const pluginEntry = pathToFileURL(path.join(repoRoot, "dist", "index.js")).href
  await writeFile(
    path.join(pluginDir, "opencode-goal.js"),
    `export { default as OpenCodeGoalPlugin } from ${JSON.stringify(pluginEntry)}\n`,
    "utf8",
  )
  await writeFile(path.join(workspace, "README.md"), "# Host canary\n", "utf8")
  await writeFile(path.join(workspace, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "canary/canary",
    small_model: "canary/canary",
    provider: {
      canary: {
        npm: "@ai-sdk/openai-compatible",
        name: "Deterministic Canary",
        options: {
          baseURL: `http://127.0.0.1:${providerPort}/v1`,
          apiKey: "canary-key",
        },
        models: {
          canary: {
            name: "Deterministic Canary",
            limit: { context: 100000, output: 4096 },
          },
        },
      },
    },
  }, null, 2) + "\n", "utf8")

  const isolatedEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    CI: "true",
  }

  const serverPort = await reservePort()
  const server = spawnOpenCode(["serve", "--hostname", "127.0.0.1", "--port", String(serverPort)], {
    cwd: workspace,
    env: isolatedEnv,
  })
  let serverLog = ""
  server.stdout?.on("data", (chunk) => { serverLog = ringAppend(serverLog, chunk) })
  server.stderr?.on("data", (chunk) => { serverLog = ringAppend(serverLog, chunk) })

  const baseURL = `http://127.0.0.1:${serverPort}`
  const headers = {
    "content-type": "application/json",
    "x-opencode-directory": encodeURIComponent(workspace),
  }
  const api = async (pathname, init = {}) => {
    const response = await fetch(`${baseURL}${pathname}`, {
      ...init,
      headers: { ...headers, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(60_000),
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`OpenCode API ${init.method ?? "GET"} ${pathname} returned ${response.status}: ${text}\nserver log:\n${serverLog}`)
    }
    if (!text) return null
    try { return JSON.parse(text) } catch { return text }
  }

  try {
    await waitForTcp(serverPort, server, () => serverLog)

    const createdSessionPayload = await api("/session", {
      method: "POST",
      body: JSON.stringify({ title: "opencode-goal host canary" }),
    })
    const session = createdSessionPayload?.data ?? createdSessionPayload
    const sessionID = String(session?.id ?? "")
    assert.ok(sessionID, `OpenCode did not create a canary session: ${JSON.stringify(createdSessionPayload)}`)

    const command = async (argumentsText) => await api(`/session/${encodeURIComponent(sessionID)}/command`, {
      method: "POST",
      body: JSON.stringify({
        agent: "build",
        model: "canary/canary",
        command: "goal",
        arguments: argumentsText,
      }),
    })

    await command("ship canary --max-turns 8")
    const created = await waitForState(
      workspace,
      (state) => state.sessionID === sessionID && state.objective === "ship canary" && state.status === "paused" && state.stalledTurns >= 3,
      "real-host create + idle continuation + no-progress pause",
    )
    assert.equal(created.revision, 1)
    assert.equal(created.status, "paused")
    assert.ok(created.usage.turns >= 1, "real host should account at least one assistant turn")
    const requestsAfterCreate = provider.stats.chatRequests
    assert.ok(requestsAfterCreate >= 3, `expected initial turn plus automatic continuations, got ${requestsAfterCreate} provider requests`)

    await command("edit ship canary v2")
    const edited = await waitForState(
      workspace,
      (state) => state.sessionID === sessionID && state.revision === 2 && state.objective === "ship canary v2" && state.status === "paused" && state.stalledTurns >= 3,
      "real-host goal edit + renewed continuation lifecycle",
    )
    assert.equal(edited.revision, 2)
    assert.ok(provider.stats.chatRequests > requestsAfterCreate, "goal edit should trigger fresh model work")

    await command("clear")
    await waitForNoGoalState(workspace)

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
    server.kill()
    await provider.close().catch(() => undefined)
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined)
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
