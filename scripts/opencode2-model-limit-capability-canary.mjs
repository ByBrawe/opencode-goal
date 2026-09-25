import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { pathToFileURL } from "node:url"

const BIN = process.env.OPENCODE2_BINARY || "opencode2"
const USER = "opencode"
const PASS = "opencode-goal-v2-model-limit"
const MODEL_CONTEXT = 123456
const MODEL_OUTPUT = 7890

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") return reject(new Error("no TCP port"))
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

async function waitForTcp(port, child, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("OpenCode exited before ready")
    const ok = await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port })
      socket.once("connect", () => { socket.destroy(); resolve(true) })
      socket.once("error", () => resolve(false))
      socket.setTimeout(500, () => { socket.destroy(); resolve(false) })
    })
    if (ok) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("OpenCode server readiness timeout")
}

async function waitFor(predicate, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 75))
  }
  throw new Error("timed out waiting for " + label)
}

async function stop(child) {
  if (!child || child.exitCode !== null) return
  child.kill("SIGTERM")
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 5000)
    child.once("close", () => { clearTimeout(timer); resolve() })
  })
}

async function readTrace(file) {
  try {
    const raw = await readFile(file, "utf8")
    return raw.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  } catch (error) {
    if (error?.code === "ENOENT") return []
    throw error
  }
}

function pluginSource() {
  return `import { appendFile } from "node:fs/promises"

const traceFile = process.env.OPENCODE_GOAL_V2_MODEL_LIMIT_TRACE

async function trace(value) {
  await appendFile(traceFile, JSON.stringify({ at: Date.now(), ...value }) + "\\n", "utf8")
}

function keys(value) {
  return value && typeof value === "object" ? Object.keys(value).sort() : []
}

function safe(value) {
  if (value === undefined) return undefined
  try { return JSON.parse(JSON.stringify(value)) } catch { return String(value) }
}

export default {
  id: "bybrawe.opencode-goal.v2.model-limit-capability",
  async setup(ctx) {
    await trace({
      phase: "setup",
      ctxKeys: keys(ctx),
      options: safe(ctx.options),
      sessionKeys: keys(ctx.session),
      eventKeys: keys(ctx.event),
      toolKeys: keys(ctx.tool),
      commandKeys: keys(ctx.command),
      catalogKeys: keys(ctx.catalog),
      dataKeys: keys(ctx.data),
      clientKeys: keys(ctx.client),
      providerKeys: keys(ctx.provider),
      modelKeys: keys(ctx.model),
      configKeys: keys(ctx.config),
    })

    const registry = {}
    try { registry.models = safe(await ctx.model?.list?.()) } catch (error) { registry.models = { error: String(error) } }
    try { registry.defaultModel = safe(await ctx.model?.default?.()) } catch (error) { registry.defaultModel = { error: String(error) } }
    try { registry.providers = safe(await ctx.provider?.list?.()) } catch (error) { registry.providers = { error: String(error) } }
    try { registry.provider = safe(await ctx.provider?.get?.({ providerID: "canary" })) } catch (error) { registry.provider = { error: String(error) } }
    await trace({ phase: "registry.reads", ...registry })

    let catalogRegistration
    if (typeof ctx.catalog?.transform === "function") {
      try {
        catalogRegistration = await ctx.catalog.transform(async (draft) => {
          let providers
          let model
          try { providers = draft?.provider?.list?.() } catch (error) { providers = { error: String(error) } }
          try { model = draft?.model?.get?.("canary", "canary") } catch (error) { model = { error: String(error) } }
          await trace({
            phase: "catalog.transform",
            draftKeys: keys(draft),
            providerKeys: keys(draft?.provider),
            modelKeys: keys(draft?.model),
            providers: safe(providers),
            model: safe(model),
          })
        })
      } catch (error) {
        await trace({ phase: "catalog.error", error: String(error?.stack || error) })
      }
    }

    const contextRegistration = await ctx.session.hook("context", async (event) => {
      await trace({
        phase: "context",
        keys: keys(event),
        sessionID: event?.sessionID,
        model: safe(event?.model),
        options: safe(event?.options),
      })
    })

    return async () => {
      await catalogRegistration?.dispose?.()
      await contextRegistration?.dispose?.()
    }
  },
}
`
}

function startProvider() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if (req.method === "GET" && url.pathname.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ object: "list", data: [{ id: "canary", object: "model", owned_by: "canary" }] }))
      return
    }
    if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
      res.writeHead(404).end()
      return
    }
    for await (const _chunk of req) {}
    const id = "chatcmpl-model-limit"
    const created = Math.floor(Date.now() / 1000)
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    })
    const send = (value) => res.write("data: " + JSON.stringify(value) + "\n\n")
    send({ id, object: "chat.completion.chunk", created, model: "canary", choices: [{ index: 0, delta: { role: "assistant", content: "MODEL_LIMIT_PROBE_OK" }, finish_reason: null }] })
    send({ id, object: "chat.completion.chunk", created, model: "canary", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 } })
    res.end("data: [DONE]\n\n")
  })
  return {
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", resolve)
      })
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("provider failed to bind")
      return address.port
    },
    async close() { await new Promise((resolve) => server.close(resolve)) },
  }
}

async function main() {
  assert.equal(process.platform, "linux")
  const workspace = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-v2-model-limit-"))
  const home = path.join(workspace, ".home")
  const pluginDir = path.join(workspace, ".opencode", "plugins")
  const traceFile = path.join(workspace, "model-limit-trace.jsonl")
  const provider = startProvider()
  const providerPort = await provider.listen()
  let child

  await Promise.all([
    mkdir(pluginDir, { recursive: true }),
    mkdir(path.join(home, ".config"), { recursive: true }),
    mkdir(path.join(home, ".local", "share"), { recursive: true }),
    mkdir(path.join(home, ".local", "state"), { recursive: true }),
    mkdir(path.join(home, ".cache"), { recursive: true }),
  ])
  await writeFile(path.join(pluginDir, "model-limit-probe.js"), pluginSource(), "utf8")
  await writeFile(path.join(workspace, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "canary/canary",
    providers: {
      canary: {
        name: "Model Limit Probe",
        package: "@opencode-ai/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${providerPort}/v1` },
        models: {
          canary: {
            name: "Model Limit Probe",
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            limit: { context: MODEL_CONTEXT, output: MODEL_OUTPUT },
          },
        },
      },
    },
  }, null, 2) + "\n", "utf8")

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    OPENCODE_GOAL_V2_MODEL_LIMIT_TRACE: traceFile,
    OPENCODE_SERVER_USERNAME: USER,
    OPENCODE_SERVER_PASSWORD: PASS,
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    CI: "true",
  }

  try {
    const version = String(execFileSync(BIN, ["--version"], { cwd: workspace, env, encoding: "utf8" })).trim()
    assert.ok(version.includes("2.0.11"))

    const port = await reservePort()
    child = spawn(BIN, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: workspace, env })
    await waitForTcp(port, child)

    const base = `http://127.0.0.1:${port}`
    const authorization = "Basic " + Buffer.from(USER + ":" + PASS).toString("base64")
    const request = async (pathname, init = {}) => {
      const response = await fetch(base + pathname, {
        ...init,
        headers: {
          "content-type": "application/json",
          "x-opencode-directory": workspace,
          authorization,
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(30000),
      })
      const text = await response.text()
      let body
      try { body = text ? JSON.parse(text) : null } catch { body = text }
      return { ok: response.ok, status: response.status, body, text }
    }

    await waitFor(async () => (await request("/api/command", { method: "GET" }).catch(() => null))?.ok, "plugin-aware API")

    const created = await request("/api/session", { method: "POST", body: JSON.stringify({ title: "model limit probe" }) })
    assert.ok(created.ok)
    const sessionID = String((created.body?.data ?? created.body)?.id ?? "")
    assert.ok(sessionID)

    const prompt = await request(`/api/session/${encodeURIComponent(sessionID)}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "probe model limit context", delivery: "steer", resume: true }),
    })
    assert.ok(prompt.ok, prompt.text)

    const trace = await waitFor(async () => {
      const values = await readTrace(traceFile)
      return values.some((item) => item.phase === "context") ? values : null
    }, "context trace")

    const setup = trace.find((item) => item.phase === "setup")
    const context = trace.find((item) => item.phase === "context")
    const catalog = trace.find((item) => item.phase === "catalog.transform")
    const registry = trace.find((item) => item.phase === "registry.reads")
    assert.ok(setup)
    assert.ok(context)
    assert.ok(registry)

    console.log(JSON.stringify({
      ok: true,
      version,
      expectedLimit: { context: MODEL_CONTEXT, output: MODEL_OUTPUT },
      setup,
      context,
      registry,
      catalog: catalog ?? null,
      trace,
    }, null, 2))
  } finally {
    await stop(child)
    await provider.close().catch(() => undefined)
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined)
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
