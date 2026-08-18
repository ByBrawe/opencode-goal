import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const EXACT_ARGUMENTS = "origin event diagnostic"
const MANAGED_BRIDGE = "OpenCode Goals command bridge. The OpenCode Goals plugin should intercept this command before model execution.\nRequested /goal arguments:\n$ARGUMENTS"

async function run(command, args, { cwd, env, allowFailure = false, timeout = 90_000 } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`command timed out: ${command} ${args.join(" ")}\n${stdout}\n${stderr}`))
    }, timeout)
    child.stdout?.on("data", (chunk) => { stdout = (stdout + String(chunk)).slice(-180_000) })
    child.stderr?.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-180_000) })
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
  const stats = { requests: 0 }
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
    stats.requests += 1
    const id = `origin-${stats.requests}`
    const created = Math.floor(Date.now() / 1000)
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" })
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "canary", choices: [{ index: 0, delta: { role: "assistant", content: "ORIGIN_EVENT_DIAGNOSTIC_DONE" }, finish_reason: null }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "canary", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 } })}\n\n`)
    res.end("data: [DONE]\n\n")
  })
  return {
    stats,
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
    'const trace = (event) => appendFileSync(traceFile, `${JSON.stringify({ at: Date.now(), ...event })}\\n`, "utf8")',
    'const keys = (value) => value && (typeof value === "object" || typeof value === "function") ? Reflect.ownKeys(value).map(String).slice(0, 100) : []',
    'function safe(value, depth = 0) {',
    '  if (value === null || value === undefined) return value',
    '  if (typeof value === "string") return value.slice(0, 800)',
    '  if (typeof value === "number" || typeof value === "boolean") return value',
    '  if (typeof value === "bigint") return String(value)',
    '  if (typeof value === "function") return { function: value.name, length: value.length }',
    '  if (depth >= 3) return { keys: keys(value) }',
    '  if (Array.isArray(value)) return value.slice(0, 12).map((item) => safe(item, depth + 1))',
    '  if (typeof value === "object") {',
    '    const out = {}',
    '    for (const key of keys(value).slice(0, 40)) {',
    '      try { out[key] = safe(value[key], depth + 1) } catch (error) { out[key] = { readError: String(error) } }',
    '    }',
    '    return out',
    '  }',
    '  return { type: typeof value }',
    '}',
    'function messageShape(message) {',
    '  if (!message || typeof message !== "object") return safe(message)',
    '  const content = Array.isArray(message.content) ? message.content : []',
    '  return {',
    '    keys: keys(message),',
    '    id: message.id,',
    '    role: message.role,',
    '    metadataKeys: keys(message.metadata),',
    '    metadata: safe(message.metadata),',
    '    content: content.map((part) => safe(part)),',
    '  }',
    '}',
    'function contextShape(event) {',
    '  return {',
    '    keys: keys(event),',
    '    sessionID: event?.sessionID,',
    '    agent: event?.agent,',
    '    messages: Array.isArray(event?.messages) ? event.messages.map(messageShape) : safe(event?.messages),',
    '    tools: event?.tools && typeof event.tools === "object" ? Object.keys(event.tools) : [],',
    '  }',
    '}',
    'function eventEnvelope(event) {',
    '  return {',
    '    keys: keys(event),',
    '    type: event?.type,',
    '    tag: event?._tag,',
    '    name: event?.name,',
    '    sessionID: event?.sessionID ?? event?.properties?.sessionID ?? event?.data?.sessionID,',
    '    properties: safe(event?.properties),',
    '    data: safe(event?.data),',
    '    value: safe(event),',
    '  }',
    '}',
    'const diagnostic = {',
    '  id: target.id,',
    '  async setup(ctx) {',
    '    trace({ phase: "event-surface", eventKeys: keys(ctx.event), subscribeType: typeof ctx.event?.subscribe, subscribeLength: typeof ctx.event?.subscribe === "function" ? ctx.event.subscribe.length : null })',
    '    if (typeof ctx.event?.subscribe === "function") {',
    '      const stream = ctx.event.subscribe()',
    '      void (async () => {',
    '        try {',
    '          for await (const event of stream) trace({ phase: "host-event", event: eventEnvelope(event) })',
    '        } catch (error) { trace({ phase: "host-event-error", error: String(error) }) }',
    '      })()',
    '    }',
    '    const wrappedCtx = new Proxy(ctx, {',
    '      get(targetCtx, prop, receiver) {',
    '        const value = Reflect.get(targetCtx, prop, receiver)',
    '        if (prop !== "session" || !value || typeof value !== "object") return value',
    '        return new Proxy(value, {',
    '          get(domain, method, domainReceiver) {',
    '            const original = Reflect.get(domain, method, domainReceiver)',
    '            if (method !== "hook" || typeof original !== "function") return original',
    '            return async function (name, callback, ...rest) {',
    '              return await Reflect.apply(original, domain, [name, function (event, ...callbackRest) {',
    '                if (name === "context") trace({ phase: "context-enter", event: contextShape(event) })',
    '                const result = Reflect.apply(callback, this, [event, ...callbackRest])',
    '                if (result && typeof result.then === "function") return result.then((value) => { if (name === "context") trace({ phase: "context-after", event: contextShape(event) }); return value })',
    '                if (name === "context") trace({ phase: "context-after", event: contextShape(event) })',
    '                return result',
    '              }, ...rest])',
    '            }',
    '          },',
    '        })',
    '      },',
    '    })',
    '    return await target.setup(wrappedCtx)',
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

async function main() {
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-v2-origin-"))
  const project = path.join(temp, "project")
  const home = path.join(temp, "home")
  const config = path.join(home, ".config")
  const data = path.join(home, ".local", "share")
  const state = path.join(home, ".local", "state")
  const pluginDir = path.join(project, ".opencode", "plugins")
  const traceFile = path.join(temp, "origin-event-trace.jsonl")
  const target = pathToFileURL(path.join(root, "dist", "opencode2", "experimental.js")).href
  const provider = startProvider()
  const port = await provider.listen()

  await Promise.all([mkdir(pluginDir, { recursive: true }), mkdir(config, { recursive: true }), mkdir(data, { recursive: true }), mkdir(state, { recursive: true })])
  await writeFile(path.join(pluginDir, "opencode-goals-v2-origin.js"), bridgeSource(target, traceFile))
  await writeFile(path.join(project, "README.md"), "# V2 origin event diagnostic\n")
  await writeFile(path.join(project, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "canary/canary",
    provider: { canary: { npm: "@ai-sdk/openai-compatible", name: "V2 origin", options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "canary" }, models: { canary: { name: "V2 origin", limit: { context: 100000, output: 4096 } } } } },
    command: { goal: { template: MANAGED_BRIDGE, description: "V2 origin command", agent: "build", subtask: false } },
  }, null, 2)}\n`)

  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data, XDG_STATE_HOME: state, OPENCODE_DB: path.join(data, "opencode", "origin.db"), OPENCODE_LOG_LEVEL: "DEBUG", CI: "true" }
  await run("git", ["init", "-q"], { cwd: project, env })
  await run("git", ["config", "user.name", "V2 Origin"], { cwd: project, env })
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

  try {
    await run("opencode2", ["service", "stop"], { cwd: project, env, allowFailure: true, timeout: 20_000 })
    const version = String((await run("opencode2", ["--version"], { cwd: project, env, timeout: 30_000 })).stdout).trim()
    await api("get", "/api/health")
    await waitFor(async () => {
      const response = await api("get", "/api/command")
      const list = response?.data ?? response
      return Array.isArray(list) && list.some((item) => item?.name === "goal" || item?.id === "goal")
    }, "goal command")
    const created = await api("post", "/api/session", { title: "origin", agent: "build", model: { id: "canary", providerID: "canary" }, location: { directory: project } })
    const session = created?.data ?? created
    const sessionID = String(session?.id ?? "")
    assert.ok(sessionID)
    await api("post", `/api/session/${encodeURIComponent(sessionID)}/command`, { command: "goal", arguments: EXACT_ARGUMENTS, agent: "build", model: { id: "canary", providerID: "canary" } })
    await waitFor(() => provider.stats.requests >= 1 ? true : null, "provider request")
    await new Promise((resolve) => setTimeout(resolve, 500))
    const trace = await readFile(traceFile, "utf8")
    console.log(JSON.stringify({ version, sessionID, provider: provider.stats, trace }, null, 2))
    throw new Error("diagnostic-only: inspect V2 command-origin events and metadata")
  } finally {
    await run("opencode2", ["service", "stop"], { cwd: project, env, allowFailure: true, timeout: 20_000 }).catch(() => undefined)
    await provider.close().catch(() => undefined)
    await rm(temp, { recursive: true, force: true }).catch(() => undefined)
  }
}

main().catch((error) => { console.error(error?.stack || error); process.exitCode = 1 })
