import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const EXACT_ARGUMENTS = "visibility diagnostic"
const MANAGED_BRIDGE = "OpenCode Goals command bridge. The OpenCode Goals plugin should intercept this command before model execution.\nRequested /goal arguments:\n$ARGUMENTS"
const DIAG_DEFAULT = "opencode_goals_v2_diag_default"
const DIAG_FALSE = "opencode_goals_v2_diag_false"
const DIAG_TRUE = "opencode_goals_v2_diag_true"

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

function messageText(body) {
  return (Array.isArray(body?.messages) ? body.messages : []).map((message) => {
    const content = message?.content
    if (typeof content === "string") return content
    if (!Array.isArray(content)) return ""
    return content.map((part) => typeof part === "string" ? part : part?.text ?? part?.content ?? part?.output ?? "").join("\n")
  }).join("\n")
}

function toolNames(body) {
  if (Array.isArray(body?.tools)) return body.tools.map((item) => item?.function?.name ?? item?.name).filter((item) => typeof item === "string")
  return body?.tools && typeof body.tools === "object" ? Object.keys(body.tools) : []
}

function startProvider() {
  const stats = { requests: [] }
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
    let raw = ""
    for await (const chunk of req) raw += String(chunk)
    const body = raw ? JSON.parse(raw) : {}
    stats.requests.push({ tools: toolNames(body), text: messageText(body).slice(0, 1200) })
    const id = `diag-${stats.requests.length}`
    const created = Math.floor(Date.now() / 1000)
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" })
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "canary", choices: [{ index: 0, delta: { role: "assistant", content: "VISIBILITY_DIAGNOSTIC_DONE" }, finish_reason: null }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "canary", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 30, completion_tokens: 4, total_tokens: 34 } })}\n\n`)
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
  const emptySchema = { type: "object", properties: {}, additionalProperties: false }
  const definition = (name, codemode) => ({
    name,
    description: `OpenCode 2 visibility diagnostic ${name}`,
    input: emptySchema,
    output: emptySchema,
    ...(codemode === undefined ? {} : { codemode }),
  })
  return [
    'import { appendFileSync } from "node:fs"',
    `import target from ${JSON.stringify(targetHref)}`,
    `const traceFile = ${JSON.stringify(traceFile)}`,
    'const trace = (event) => appendFileSync(traceFile, `${JSON.stringify(event)}\\n`, "utf8")',
    `const defs = ${JSON.stringify([definition(DIAG_DEFAULT), definition(DIAG_FALSE, false), definition(DIAG_TRUE, true)])}`,
    'for (const def of defs) def.execute = async () => ({ output: {}, content: "diagnostic" })',
    'function latestUserText(messages) {',
    '  if (!Array.isArray(messages)) return ""',
    '  for (let i = messages.length - 1; i >= 0; i -= 1) {',
    '    const message = messages[i]',
    '    const role = message?.role ?? message?.info?.role',
    '    if (role && role !== "user") continue',
    '    const content = message?.content ?? message?.parts ?? message?.message?.parts',
    '    const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => typeof part === "string" ? part : part?.text ?? part?.content ?? "").join("") : message?.text ?? ""',
    '    if (text) return String(text).slice(0, 1200)',
    '  }',
    '  return ""',
    '}',
    'const diagnostic = {',
    '  id: target.id,',
    '  async setup(ctx) {',
    '    const wrappedCtx = new Proxy(ctx, {',
    '      get(targetCtx, prop, receiver) {',
    '        const value = Reflect.get(targetCtx, prop, receiver)',
    '        if (prop === "tool" && value && typeof value === "object") {',
    '          return new Proxy(value, {',
    '            get(domain, method, domainReceiver) {',
    '              const original = Reflect.get(domain, method, domainReceiver)',
    '              if (method !== "transform" || typeof original !== "function") return original',
    '              return async function (callback, ...rest) {',
    '                return await Reflect.apply(original, domain, [function (draft, ...callbackRest) {',
    '                  const result = Reflect.apply(callback, this, [draft, ...callbackRest])',
    '                  const addDiagnostic = () => {',
    '                    for (const def of defs) {',
    '                      if (draft.add.length === 1) draft.add(def)',
    '                      else draft.add(def.name, def, { codemode: def.codemode })',
    '                    }',
    '                    trace({ phase: "diagnostic-tools-added", addLength: draft.add.length, definitions: defs.map((def) => ({ name: def.name, codemode: def.codemode })) })',
    '                  }',
    '                  if (result && typeof result.then === "function") return result.then((value) => { addDiagnostic(); return value })',
    '                  addDiagnostic()',
    '                  return result',
    '                }, ...rest])',
    '              }',
    '            },',
    '          })',
    '        }',
    '        if (prop === "session" && value && typeof value === "object") {',
    '          return new Proxy(value, {',
    '            get(domain, method, domainReceiver) {',
    '              const original = Reflect.get(domain, method, domainReceiver)',
    '              if (method !== "hook" || typeof original !== "function") return original',
    '              return async function (name, callback, ...rest) {',
    '                return await Reflect.apply(original, domain, [name, function (event, ...callbackRest) {',
    '                  trace({ phase: "session-hook-enter", hook: name, tools: event?.tools && typeof event.tools === "object" ? Object.keys(event.tools) : [], latestUserText: latestUserText(event?.messages) })',
    '                  const result = Reflect.apply(callback, this, [event, ...callbackRest])',
    '                  const after = () => trace({ phase: "session-hook-after", hook: name, tools: event?.tools && typeof event.tools === "object" ? Object.keys(event.tools) : [], latestUserText: latestUserText(event?.messages) })',
    '                  if (result && typeof result.then === "function") return result.then((value) => { after(); return value })',
    '                  after()',
    '                  return result',
    '                }, ...rest])',
    '              }',
    '            },',
    '          })',
    '        }',
    '        return value',
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
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-v2-visibility-"))
  const project = path.join(temp, "project")
  const home = path.join(temp, "home")
  const config = path.join(home, ".config")
  const data = path.join(home, ".local", "share")
  const state = path.join(home, ".local", "state")
  const pluginDir = path.join(project, ".opencode", "plugins")
  const traceFile = path.join(temp, "visibility-trace.jsonl")
  const target = pathToFileURL(path.join(root, "dist", "opencode2", "experimental.js")).href
  const provider = startProvider()
  const port = await provider.listen()

  await Promise.all([mkdir(pluginDir, { recursive: true }), mkdir(config, { recursive: true }), mkdir(data, { recursive: true }), mkdir(state, { recursive: true })])
  await writeFile(path.join(pluginDir, "opencode-goals-v2-visibility.js"), bridgeSource(target, traceFile))
  await writeFile(path.join(project, "README.md"), "# V2 visibility diagnostic\n")
  await writeFile(path.join(project, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "canary/canary",
    provider: { canary: { npm: "@ai-sdk/openai-compatible", name: "V2 visibility", options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "canary" }, models: { canary: { name: "V2 visibility", limit: { context: 100000, output: 4096 } } } } },
    command: { goal: { template: MANAGED_BRIDGE, description: "V2 managed bridge visibility", agent: "build", subtask: false } },
  }, null, 2)}\n`)

  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data, XDG_STATE_HOME: state, OPENCODE_DB: path.join(data, "opencode", "visibility.db"), OPENCODE_LOG_LEVEL: "DEBUG", CI: "true" }
  await run("git", ["init", "-q"], { cwd: project, env })
  await run("git", ["config", "user.name", "V2 Diagnostic"], { cwd: project, env })
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
    const created = await api("post", "/api/session", { title: "visibility", agent: "build", model: { id: "canary", providerID: "canary" }, location: { directory: project } })
    const session = created?.data ?? created
    const sessionID = String(session?.id ?? "")
    assert.ok(sessionID)
    await api("post", `/api/session/${encodeURIComponent(sessionID)}/command`, { command: "goal", arguments: EXACT_ARGUMENTS, agent: "build", model: { id: "canary", providerID: "canary" } })
    await waitFor(() => provider.stats.requests.length >= 1 ? true : null, "provider request")
    const trace = await readFile(traceFile, "utf8")
    const first = provider.stats.requests[0]
    console.log(JSON.stringify({ version, firstRequestTools: first?.tools ?? [], firstRequestText: first?.text ?? "", trace }, null, 2))
    throw new Error("diagnostic-only: inspect codemode visibility and context marker")
  } finally {
    await run("opencode2", ["service", "stop"], { cwd: project, env, allowFailure: true, timeout: 20_000 }).catch(() => undefined)
    await provider.close().catch(() => undefined)
    await rm(temp, { recursive: true, force: true }).catch(() => undefined)
  }
}

main().catch((error) => { console.error(error?.stack || error); process.exitCode = 1 })
