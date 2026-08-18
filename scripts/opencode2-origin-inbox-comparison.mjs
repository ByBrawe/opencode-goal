import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const ARGUMENTS = "same bridge bytes"
const BRIDGE_TEXT = `OpenCode Goals command bridge. The OpenCode Goals plugin should intercept this command before model execution.\nRequested /goal arguments:\n${ARGUMENTS}`
const BRIDGE_TEMPLATE = "OpenCode Goals command bridge. The OpenCode Goals plugin should intercept this command before model execution.\nRequested /goal arguments:\n$ARGUMENTS"

async function run(command, args, { cwd, env, allowFailure = false, timeout = 90_000 } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`command timed out: ${command} ${args.join(" ")}\n${stdout}\n${stderr}`))
    }, timeout)
    child.stdout?.on("data", (chunk) => { stdout = (stdout + String(chunk)).slice(-120_000) })
    child.stderr?.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-120_000) })
    child.once("error", (error) => { clearTimeout(timer); reject(error) })
    child.once("close", (status) => {
      clearTimeout(timer)
      if (!allowFailure && status !== 0) return reject(new Error(`command failed (${status}): ${command} ${args.join(" ")}\n${stdout}\n${stderr}`))
      resolve({ status, stdout, stderr })
    })
  })
}

function parse(result, label) {
  try { return JSON.parse(String(result.stdout ?? "").trim()) }
  catch { throw new Error(`${label} did not return JSON\n${result.stdout}\n${result.stderr}`) }
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
      res.writeHead(404, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: "unexpected endpoint" } }))
      return
    }
    for await (const _chunk of req) {}
    const created = Math.floor(Date.now() / 1000)
    const id = `inbox-${created}`
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" })
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "canary", choices: [{ index: 0, delta: { role: "assistant", content: "INBOX_COMPARE_DONE" }, finish_reason: null }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "canary", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 30, completion_tokens: 4, total_tokens: 34 } })}\n\n`)
    res.end("data: [DONE]\n\n")
  })
  return {
    async listen() {
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("provider did not bind")
      return address.port
    },
    async close() { await new Promise((resolve) => server.close(resolve)) },
  }
}

function bridgeSource(targetHref, traceFile) {
  return [
    'import { appendFileSync } from "node:fs"',
    `import target from ${JSON.stringify(targetHref)}`,
    `const traceFile = ${JSON.stringify(traceFile)}`,
    'const trace = (event) => appendFileSync(traceFile, `${JSON.stringify(event)}\\n`, "utf8")',
    'const diagnostic = {',
    '  id: target.id,',
    '  async setup(ctx) {',
    '    if (typeof ctx.event?.subscribe === "function") {',
    '      const stream = ctx.event.subscribe()',
    '      void (async () => {',
    '        try {',
    '          for await (const event of stream) {',
    '            if (event?.type === "session.inbox.enqueued") {',
    '              trace({ type: event.type, data: event.data, metadata: event.metadata, location: event.location })',
    '            }',
    '          }',
    '        } catch (error) { trace({ type: "diagnostic.error", error: String(error) }) }',
    '      })()',
    '    }',
    '    return await target.setup(ctx)',
    '  },',
    '}',
    'export default diagnostic',
    '',
  ].join("\n")
}

async function waitFor(predicate, label, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for ${label}`)
}

function normalizeInbox(event) {
  const item = event?.data?.item ?? null
  if (!item) return null
  return {
    type: item.type,
    payload: item.payload,
    delivery: item.delivery,
    metadata: event.metadata,
  }
}

async function main() {
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-v2-inbox-"))
  const project = path.join(temp, "project")
  const home = path.join(temp, "home")
  const config = path.join(home, ".config")
  const data = path.join(home, ".local", "share")
  const state = path.join(home, ".local", "state")
  const pluginDir = path.join(project, ".opencode", "plugins")
  const traceFile = path.join(temp, "inbox-trace.jsonl")
  const target = pathToFileURL(path.join(root, "dist", "opencode2", "experimental.js")).href
  const provider = startProvider()
  const port = await provider.listen()

  await Promise.all([mkdir(pluginDir, { recursive: true }), mkdir(config, { recursive: true }), mkdir(data, { recursive: true }), mkdir(state, { recursive: true })])
  await writeFile(path.join(pluginDir, "opencode-goals-v2-inbox.js"), bridgeSource(target, traceFile))
  await writeFile(path.join(project, "README.md"), "# V2 inbox comparison\n")
  await writeFile(path.join(project, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "canary/canary",
    provider: { canary: { npm: "@ai-sdk/openai-compatible", name: "V2 inbox", options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "canary" }, models: { canary: { name: "V2 inbox", limit: { context: 100000, output: 4096 } } } } },
    command: { goal: { template: BRIDGE_TEMPLATE, description: "V2 inbox compare", agent: "build", subtask: false } },
  }, null, 2)}\n`)

  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data, XDG_STATE_HOME: state, OPENCODE_DB: path.join(data, "opencode", "inbox.db"), OPENCODE_LOG_LEVEL: "DEBUG", CI: "true" }
  await run("git", ["init", "-q"], { cwd: project, env })
  await run("git", ["config", "user.name", "V2 Inbox"], { cwd: project, env })
  await run("git", ["config", "user.email", "v2@example.invalid"], { cwd: project, env })
  await run("git", ["add", "."], { cwd: project, env })
  await run("git", ["commit", "-q", "-m", "init"], { cwd: project, env })

  const q = `location%5Bdirectory%5D=${encodeURIComponent(project)}`
  const api = async (method, pathname, dataValue) => {
    const args = ["api", method, `${pathname}?${q}`]
    if (dataValue !== undefined) args.push("--data", JSON.stringify(dataValue))
    const result = await run("opencode2", args, { cwd: project, env })
    return String(result.stdout).trim() ? parse(result, `${method} ${pathname}`) : null
  }
  const createSession = async (title) => {
    const created = await api("post", "/api/session", { title, agent: "build", model: { id: "canary", providerID: "canary" }, location: { directory: project } })
    const session = created?.data ?? created
    const id = String(session?.id ?? "")
    assert.ok(id)
    return id
  }

  try {
    await run("opencode2", ["service", "stop"], { cwd: project, env, allowFailure: true, timeout: 20_000 })
    const version = String((await run("opencode2", ["--version"], { cwd: project, env, timeout: 30_000 })).stdout).trim()
    await api("get", "/api/health")
    await waitFor(async () => {
      const response = await api("get", "/api/command")
      const list = response?.data ?? response
      return Array.isArray(list) && list.some((item) => item?.name === "goal" || item?.id === "goal")
    }, "goal command")

    const commandSessionID = await createSession("command-inbox")
    await api("post", `/api/session/${encodeURIComponent(commandSessionID)}/command`, { command: "goal", arguments: ARGUMENTS, agent: "build", model: { id: "canary", providerID: "canary" } })

    const promptSessionID = await createSession("prompt-inbox")
    await api("post", `/api/session/${encodeURIComponent(promptSessionID)}/prompt`, { prompt: { text: BRIDGE_TEXT }, delivery: "steer", resume: false })

    const events = await waitFor(async () => {
      try {
        const raw = await readFile(traceFile, "utf8")
        const parsed = raw.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
        const command = parsed.find((event) => event?.data?.sessionID === commandSessionID)
        const prompt = parsed.find((event) => event?.data?.sessionID === promptSessionID)
        return command && prompt ? { command, prompt, all: parsed } : null
      } catch { return null }
    }, "both inbox events")

    const commandNormalized = normalizeInbox(events.command)
    const promptNormalized = normalizeInbox(events.prompt)
    const identical = JSON.stringify(commandNormalized) === JSON.stringify(promptNormalized)
    console.log(JSON.stringify({ version, commandSessionID, promptSessionID, commandNormalized, promptNormalized, identical, allEvents: events.all }, null, 2))
    throw new Error(`diagnostic-only: command/prompt inbox origin identical=${identical}`)
  } finally {
    await run("opencode2", ["service", "stop"], { cwd: project, env, allowFailure: true, timeout: 20_000 }).catch(() => undefined)
    await provider.close().catch(() => undefined)
    await rm(temp, { recursive: true, force: true }).catch(() => undefined)
  }
}

main().catch((error) => { console.error(error?.stack || error); process.exitCode = 1 })
