import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"
import { GoalStore } from "../dist/persistence/store.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const CONTROL_TOOL = "opencode_goals_v2_control"
const GET_TOOL = "opencode_goals_v2_get"
const ARGUMENTS = 'deferred registration goal --success "goal persisted" --constraint "preserve random capability"'
const DECLARED_TEMPLATE = "DECLARED_GOAL_TEMPLATE\n$ARGUMENTS"
const WRAPPER = "OpenCode Goals V2 command wrapper"

async function run(command, args, { cwd, env, allowFailure = false, timeout = 90_000 } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`command timed out: ${command} ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, timeout)
    child.stdout?.on("data", (chunk) => { stdout = (stdout + String(chunk)).slice(-180_000) })
    child.stderr?.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-180_000) })
    child.once("error", (error) => { clearTimeout(timer); reject(error) })
    child.once("close", (status) => {
      clearTimeout(timer)
      if (!allowFailure && status !== 0) return reject(new Error(`command failed (${status}): ${command} ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
      resolve({ status, stdout, stderr })
    })
  })
}

function parse(result, label) {
  const text = String(result.stdout ?? "").trim()
  try { return JSON.parse(text) }
  catch { throw new Error(`${label} did not return JSON\nstdout:\n${text}\nstderr:\n${result.stderr}`) }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function readText(file) {
  try { return await readFile(file, "utf8") } catch { return "" }
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
      res.end(JSON.stringify({ error: { message: `unexpected endpoint ${req.method} ${url.pathname}` } }))
      return
    }

    let raw = ""
    for await (const chunk of req) raw += String(chunk)
    const body = raw ? JSON.parse(raw) : {}
    const names = toolNames(body)
    const text = messageText(body)
    const request = stats.requests.length + 1
    const observation = {
      request,
      tools: names,
      hasControl: names.includes(CONTROL_TOOL),
      hasGet: names.includes(GET_TOOL),
      sawWrapper: text.includes(WRAPPER),
      sawArguments: text.includes(ARGUMENTS),
    }
    stats.requests.push(observation)

    const id = `after-policy-${request}`
    const created = Math.floor(Date.now() / 1000)
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" })
    const send = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`)

    if (request === 1 && observation.hasControl) {
      send({
        id,
        object: "chat.completion.chunk",
        created,
        model: "canary",
        choices: [{
          index: 0,
          delta: {
            role: "assistant",
            content: null,
            tool_calls: [{ index: 0, id: "call-after-policy-control", type: "function", function: { name: CONTROL_TOOL, arguments: "" } }],
          },
          finish_reason: null,
        }],
      })
      send({
        id,
        object: "chat.completion.chunk",
        created,
        model: "canary",
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ arguments: ARGUMENTS }) } }] }, finish_reason: null }],
      })
      send({ id, object: "chat.completion.chunk", created, model: "canary", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 50, completion_tokens: 12, total_tokens: 62 } })
    } else {
      send({ id, object: "chat.completion.chunk", created, model: "canary", choices: [{ index: 0, delta: { role: "assistant", content: "AFTER_POLICY_DONE" }, finish_reason: null }] })
      send({ id, object: "chat.completion.chunk", created, model: "canary", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 35, completion_tokens: 5, total_tokens: 40 } })
    }
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
    'const deferredCommand = []',
    'const deferredTool = []',
    'let scheduled = false',
    'let registered = false',
    'let disposed = false',
    'async function registerDeferred(ctx) {',
    '  if (registered || disposed) return',
    '  registered = true',
    '  trace({ phase: "deferred.register.begin", commandCount: deferredCommand.length, toolCount: deferredTool.length })',
    '  try {',
    '    for (const callback of deferredCommand) await ctx.command.transform(callback)',
    '    for (const callback of deferredTool) await ctx.tool.transform(callback)',
    '    trace({ phase: "deferred.register.done" })',
    '  } catch (error) { trace({ phase: "deferred.register.error", error: String(error) }) }',
    '}',
    'function scheduleRegistration(ctx) {',
    '  if (scheduled || disposed) return',
    '  scheduled = true',
    '  trace({ phase: "deferred.register.scheduled" })',
    '  setTimeout(() => { void registerDeferred(ctx) }, 0)',
    '}',
    'const diagnostic = {',
    '  id: target.id,',
    '  async setup(ctx) {',
    '    if (typeof ctx.event?.subscribe === "function") {',
    '      const stream = ctx.event.subscribe()',
    '      void (async () => {',
    '        try {',
    '          for await (const event of stream) {',
    '            if (event?.type !== "plugin.added") continue',
    '            const id = event?.data?.id',
    '            trace({ phase: "plugin.added", id })',
    '            if (id === "opencode.config.policy") scheduleRegistration(ctx)',
    '          }',
    '        } catch (error) { trace({ phase: "event.loop.error", error: String(error) }) }',
    '      })()',
    '    }',
    '    const wrappedCtx = new Proxy(ctx, {',
    '      get(targetCtx, prop, receiver) {',
    '        const value = Reflect.get(targetCtx, prop, receiver)',
    '        if (prop === "command" && value && typeof value === "object") {',
    '          return new Proxy(value, { get(domain, method, domainReceiver) {',
    '            const original = Reflect.get(domain, method, domainReceiver)',
    '            if (method !== "transform") return original',
    '            return async function (callback) { deferredCommand.push(callback); trace({ phase: "command.transform.deferred", count: deferredCommand.length }) }',
    '          } })',
    '        }',
    '        if (prop === "tool" && value && typeof value === "object") {',
    '          return new Proxy(value, { get(domain, method, domainReceiver) {',
    '            const original = Reflect.get(domain, method, domainReceiver)',
    '            if (method !== "transform") return original',
    '            return async function (callback) { deferredTool.push(callback); trace({ phase: "tool.transform.deferred", count: deferredTool.length }) }',
    '          } })',
    '        }',
    '        return value',
    '      },',
    '    })',
    '    const cleanup = await target.setup(wrappedCtx)',
    '    trace({ phase: "target.setup.done" })',
    '    return () => { disposed = true; if (typeof cleanup === "function") cleanup() }',
    '  },',
    '}',
    'export default diagnostic',
    '',
  ].join("\n")
}

async function waitFor(predicate, label, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function main() {
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-v2-after-policy-"))
  const project = path.join(temp, "project")
  const home = path.join(temp, "home")
  const config = path.join(home, ".config")
  const data = path.join(home, ".local", "share")
  const state = path.join(home, ".local", "state")
  const pluginDir = path.join(project, ".opencode", "plugins")
  const traceFile = path.join(temp, "after-policy-trace.jsonl")
  const targetHref = pathToFileURL(path.join(root, "dist", "opencode2", "experimental.js")).href
  const provider = startProvider()
  const port = await provider.listen()

  await Promise.all([mkdir(pluginDir, { recursive: true }), mkdir(config, { recursive: true }), mkdir(data, { recursive: true }), mkdir(state, { recursive: true })])
  await writeFile(path.join(pluginDir, "opencode-goals-v2-after-policy.js"), bridgeSource(targetHref, traceFile))
  await writeFile(path.join(project, "README.md"), "# V2 deferred registration after policy\n")
  await writeFile(path.join(project, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "canary/canary",
    provider: { canary: { npm: "@ai-sdk/openai-compatible", name: "V2 after policy", options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "canary" }, models: { canary: { name: "V2 after policy", limit: { context: 100000, output: 4096 } } } } },
    command: { goal: { template: DECLARED_TEMPLATE, description: "V2 after policy goal", agent: "build", subtask: false } },
  }, null, 2)}\n`)

  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data, XDG_STATE_HOME: state, OPENCODE_DB: path.join(data, "opencode", "after-policy.db"), OPENCODE_LOG_LEVEL: "DEBUG", CI: "true" }
  await run("git", ["init", "-q"], { cwd: project, env })
  await run("git", ["config", "user.name", "V2 After Policy"], { cwd: project, env })
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

    await waitFor(async () => (await readText(traceFile)).includes('"phase":"deferred.register.done"') ? true : null, "post-policy transform registration")

    const commandCatalog = await waitFor(async () => {
      const response = await api("get", "/api/command")
      const list = response?.data ?? response
      if (!Array.isArray(list)) return null
      const goal = list.find((item) => item?.name === "goal" || item?.id === "goal")
      return goal?.template?.includes(WRAPPER) ? goal : null
    }, "random Goal wrapper to become authoritative")

    const created = await api("post", "/api/session", { title: "after-policy", agent: "build", model: { id: "canary", providerID: "canary" }, location: { directory: project } })
    const session = created?.data ?? created
    const sessionID = String(session?.id ?? "")
    assert.ok(sessionID)

    const commandAdmission = await api("post", `/api/session/${encodeURIComponent(sessionID)}/command`, { command: "goal", arguments: ARGUMENTS, agent: "build", model: { id: "canary", providerID: "canary" } })
    await sleep(1500)

    const goal = await new GoalStore(project).load(sessionID)
    const trace = await readText(traceFile)
    const first = provider.stats.requests[0] ?? null
    const second = provider.stats.requests[1] ?? null

    console.log(JSON.stringify({
      version,
      sessionID,
      commandAdmission,
      commandCatalog: { template: commandCatalog?.template },
      firstRequest: first,
      secondRequest: second,
      goal: goal ? { id: goal.id, objective: goal.objective, constraints: goal.constraints, status: goal.status } : null,
      trace,
    }, null, 2))

    throw new Error(`diagnostic-only: firstControl=${Boolean(first?.hasControl)} firstGet=${Boolean(first?.hasGet)} firstWrapper=${Boolean(first?.sawWrapper)} goalPersisted=${Boolean(goal)} secondControl=${Boolean(second?.hasControl)}`)
  } finally {
    await run("opencode2", ["service", "stop"], { cwd: project, env, allowFailure: true, timeout: 20_000 }).catch(() => undefined)
    await provider.close().catch(() => undefined)
    await rm(temp, { recursive: true, force: true }).catch(() => undefined)
  }
}

main().catch((error) => { console.error(error?.stack || error); process.exitCode = 1 })
