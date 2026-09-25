import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const pluginServer = path.join(root, "dist", "server.js")
const OPENCODE_BINARY = process.env.OPENCODE2_BINARY || "opencode2"
const USERNAME = "opencode"
const PASSWORD = "opencode-goal-v2-todo-materialization"

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") return reject(new Error("failed to reserve port"))
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

async function waitForTcp(port, child, logs, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`OpenCode exited before ready.\n${logs()}`)
    const ok = await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port })
      socket.once("connect", () => { socket.destroy(); resolve(true) })
      socket.once("error", () => resolve(false))
      socket.setTimeout(500, () => { socket.destroy(); resolve(false) })
    })
    if (ok) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`OpenCode readiness timeout\n${logs()}`)
}

async function stop(child) {
  if (!child || child.exitCode !== null) return
  child.kill("SIGTERM")
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 5_000)
    child.once("close", () => { clearTimeout(timer); resolve() })
  })
}

function toolNames(body) {
  if (Array.isArray(body?.tools)) {
    return body.tools.map((item) => item?.function?.name ?? item?.name).filter((item) => typeof item === "string")
  }
  if (body?.tools && typeof body.tools === "object") return Object.keys(body.tools)
  return []
}

function streamText(res, sequence) {
  const id = `chatcmpl-todo-materialization-${sequence}`
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
    choices: [{ index: 0, delta: { role: "assistant", content: "MATERIALIZATION_PROBED" }, finish_reason: null }],
  })
  send({
    id,
    object: "chat.completion.chunk",
    created,
    model: "canary",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 },
  })
  res.end("data: [DONE]\n\n")
}

function startProvider(label) {
  const stats = { requests: [] }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if (req.method === "GET" && url.pathname.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ object: "list", data: [{ id: "canary", object: "model", owned_by: label }] }))
      return
    }
    if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" })
      res.end("{}")
      return
    }
    let raw = ""
    for await (const chunk of req) raw += String(chunk)
    const body = raw ? JSON.parse(raw) : {}
    stats.requests.push({
      sequence: stats.requests.length + 1,
      tools: toolNames(body),
      rawToolDefinitions: Array.isArray(body?.tools)
        ? body.tools.map((item) => ({
            name: item?.function?.name ?? item?.name,
            description: item?.function?.description ?? item?.description,
            parameters: item?.function?.parameters ?? item?.input_schema ?? item?.inputSchema,
          }))
        : body?.tools,
    })
    streamText(res, stats.requests.length)
  })
  return {
    stats,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", resolve)
      })
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("provider failed to bind")
      return address.port
    },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

async function runHost({ withGoalPlugin }) {
  const label = withGoalPlugin ? "goal-plugin" : "stock"
  const workspace = await mkdtemp(path.join(os.tmpdir(), `opencode-v2-todo-${label}-`))
  const home = path.join(workspace, ".home")
  const pluginDir = path.join(workspace, ".opencode", "plugins")
  const provider = startProvider(label)
  const providerPort = await provider.listen()
  let child
  let logs = ""
  let sessionID = ""

  try {
    await Promise.all([
      mkdir(pluginDir, { recursive: true }),
      mkdir(path.join(home, ".config"), { recursive: true }),
      mkdir(path.join(home, ".local", "share"), { recursive: true }),
      mkdir(path.join(home, ".local", "state"), { recursive: true }),
      mkdir(path.join(home, ".cache"), { recursive: true }),
    ])

    if (withGoalPlugin) {
      await writeFile(
        path.join(pluginDir, "opencode-goal-server.js"),
        `export { default } from ${JSON.stringify(pathToFileURL(pluginServer).href)}\n`,
        "utf8",
      )
    }

    await writeFile(path.join(workspace, "README.md"), `# ${label} Todo materialization proof\n`, "utf8")
    await writeFile(path.join(workspace, "opencode.json"), JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: "canary/canary",
      providers: {
        canary: {
          name: `Todo materialization ${label}`,
          package: "@opencode-ai/ai/providers/openai-compatible",
          settings: { baseURL: `http://127.0.0.1:${providerPort}/v1` },
          models: {
            canary: {
              name: `Todo materialization ${label}`,
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              limit: { context: 100000, output: 4096 },
            },
          },
        },
      },
    }, null, 2) + "\n", "utf8")

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
      OPENCODE_SERVER_USERNAME: USERNAME,
      OPENCODE_SERVER_PASSWORD: PASSWORD,
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
      CI: "true",
    }

    const port = await reservePort()
    child = spawn(OPENCODE_BINARY, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: workspace,
      env,
      windowsHide: true,
    })
    child.stdout?.on("data", (chunk) => { logs = (logs + String(chunk)).slice(-120_000) })
    child.stderr?.on("data", (chunk) => { logs = (logs + String(chunk)).slice(-120_000) })
    await waitForTcp(port, child, () => logs)

    const baseURL = `http://127.0.0.1:${port}`
    const authorization = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64")}`
    const request = async (pathname, init = {}, timeoutMs = 60_000) => {
      const response = await fetch(`${baseURL}${pathname}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          "x-opencode-directory": workspace,
          authorization,
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = await response.text()
      let body = null
      try { body = text ? JSON.parse(text) : null } catch { body = text }
      return { ok: response.ok, status: response.status, body, text }
    }

    const created = await request("/api/session", {
      method: "POST",
      body: JSON.stringify({ title: `${label} Todo materialization` }),
    })
    assert.ok(created.ok, `${label} session create failed: ${created.status} ${created.text}\n${logs}`)
    sessionID = String((created.body?.data ?? created.body)?.id ?? "")
    assert.ok(sessionID)

    const prompt = await request(`/api/session/${encodeURIComponent(sessionID)}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "inspect available tools only", delivery: "steer", resume: true }),
    }, 90_000)
    assert.ok(prompt.ok, `${label} prompt failed: ${prompt.status} ${prompt.text}\n${logs}`)

    const deadline = Date.now() + 30_000
    while (!provider.stats.requests.length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.ok(provider.stats.requests.length, `${label} provider request missing\n${logs}`)
    return {
      label,
      version: String(execFileSync(OPENCODE_BINARY, ["--version"], { cwd: workspace, env, encoding: "utf8" })).trim(),
      tools: provider.stats.requests[0].tools,
      definitions: provider.stats.requests[0].rawToolDefinitions,
    }
  } finally {
    await stop(child)
    await provider.close().catch(() => undefined)
    await rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }).catch(() => undefined)
  }
}

async function main() {
  assert.equal(process.platform, "linux")
  const stock = await runHost({ withGoalPlugin: false })
  const goal = await runHost({ withGoalPlugin: true })

  assert.ok(stock.version.includes("2.0.15"), `expected stock 2.0.15, got ${stock.version}`)
  assert.ok(goal.version.includes("2.0.15"), `expected Goal host 2.0.15, got ${goal.version}`)

  console.log(JSON.stringify({
    ok: true,
    stock: { tools: stock.tools, hasTodoWrite: stock.tools.includes("todowrite") },
    goal: { tools: goal.tools, hasTodoWrite: goal.tools.includes("todowrite") },
    removedByGoal: stock.tools.filter((name) => !goal.tools.includes(name)),
    addedByGoal: goal.tools.filter((name) => !stock.tools.includes(name)),
    stockTodoDefinition: stock.definitions?.find((item) => item?.name === "todowrite"),
    goalTodoDefinition: goal.definitions?.find((item) => item?.name === "todowrite"),
  }, null, 2))

  // This proof intentionally does not assert which side has todowrite. It
  // distinguishes an upstream materialization gap from a Goal plugin regression.
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
