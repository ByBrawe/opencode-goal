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
const EXACT_ARGUMENTS = 'real v2 goal behavior --success "exact args persist" --constraint "no unrelated mutation"'
const DECLARED_COMMAND_TEMPLATE = "UNTRANSFORMED_V2_GOAL_CANARY\n$ARGUMENTS"
const COMMAND_WRAPPER_TEXT = "OpenCode Goals V2 command wrapper"

function appendLog(current, chunk, limit = 120_000) {
  return (current + String(chunk)).slice(-limit)
}

async function run(command, args, { cwd, env, allowFailure = false, timeout = 90_000 } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true })
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
      child.kill()
      finish(reject, new Error(`command timed out: ${command} ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, timeout)
    child.once("error", (error) => finish(reject, error))
    child.once("close", (code) => {
      const result = { status: code, stdout, stderr }
      if (!allowFailure && code !== 0) {
        finish(reject, new Error(`command failed (${code}): ${command} ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
        return
      }
      finish(resolve, result)
    })
  })
}

function parseJSONOutput(result, label) {
  const text = String(result.stdout ?? "").trim()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label} did not return JSON on stdout.\nstdout:\n${text}\nstderr:\n${String(result.stderr ?? "")}`)
  }
}

async function textIfPresent(file) {
  try {
    return await readFile(file, "utf8")
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
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
  const stats = { chatRequests: 0, paths: [], observations: [] }
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
    const names = toolNames(body)
    const text = messageText(body)
    const request = ++stats.chatRequests
    stats.observations.push({
      request,
      tools: names,
      hasControl: names.includes(CONTROL_TOOL),
      hasGet: names.includes(GET_TOOL),
      sawWrapper: text.includes(COMMAND_WRAPPER_TEXT),
      sawExactArguments: text.includes(EXACT_ARGUMENTS),
    })

    const id = `chatcmpl-v2-goal-${request}`
    const created = Math.floor(Date.now() / 1000)
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" })
    const send = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`)

    if (request === 1) {
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
            tool_calls: [{ index: 0, id: "call-v2-goal-control", type: "function", function: { name: CONTROL_TOOL, arguments: "" } }],
          },
          finish_reason: null,
        }],
      })
      send({
        id,
        object: "chat.completion.chunk",
        created,
        model: "canary",
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ arguments: EXACT_ARGUMENTS }) } }] }, finish_reason: null }],
      })
      send({
        id,
        object: "chat.completion.chunk",
        created,
        model: "canary",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 48, completion_tokens: 12, total_tokens: 60 },
      })
    } else {
      send({
        id,
        object: "chat.completion.chunk",
        created,
        model: "canary",
        choices: [{ index: 0, delta: { role: "assistant", content: "V2_GOAL_CONTROL_DONE" }, finish_reason: null }],
      })
      send({
        id,
        object: "chat.completion.chunk",
        created,
        model: "canary",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 40, completion_tokens: 5, total_tokens: 45 },
      })
    }
    res.end("data: [DONE]\n\n")
  })

  return {
    stats,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", resolve)
      })
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("failed to start V2 Goal behavior provider")
      return address.port
    },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

function diagnosticBridgeSource(pluginHref, traceFile) {
  return [
    'import { appendFileSync } from "node:fs"',
    `import target from ${JSON.stringify(pluginHref)}`,
    `const traceFile = ${JSON.stringify(traceFile)}`,
    'const trace = (event) => appendFileSync(traceFile, `${JSON.stringify({ at: Date.now(), ...event })}\\n`, "utf8")',
    'const errorInfo = (error) => ({ name: error?.name ?? typeof error, message: error?.message ?? String(error) })',
    'const keys = (value) => value && (typeof value === "object" || typeof value === "function") ? Reflect.ownKeys(value).map(String).slice(0, 40) : []',
    'const eventShape = (value) => {',
    '  const request = value?.request && typeof value.request === "object" ? value.request : undefined',
    '  return {',
    '    keys: keys(value),',
    '    requestKeys: keys(request),',
    '    sessionID: value?.sessionID ?? request?.sessionID ?? request?.session?.id,',
    '    agent: value?.agent ?? value?.agentID ?? request?.agent ?? request?.agent?.id,',
    '    messages: Array.isArray(value?.messages) ? value.messages.length : typeof value?.messages,',
    '    tools: value?.tools && typeof value.tools === "object" ? Object.keys(value.tools).slice(0, 30) : typeof value?.tools,',
    '    system: Array.isArray(value?.system) ? value.system.length : typeof value?.system,',
    '  }',
    '}',
    'function wrapCommandDraft(draft) {',
    '  if (!draft || (typeof draft !== "object" && typeof draft !== "function")) return draft',
    '  return new Proxy(draft, {',
    '    get(targetDraft, prop, receiver) {',
    '      const original = Reflect.get(targetDraft, prop, receiver)',
    '      if (prop !== "update" || typeof original !== "function") return original',
    '      return function (name, mutate, ...rest) {',
    '        trace({ phase: "command.update.before", name, updateLength: original.length, updateSource: Function.prototype.toString.call(original).slice(0, 500) })',
    '        const wrappedMutate = typeof mutate === "function" ? function (command, ...mutateRest) {',
    '          trace({ phase: "command.mutate.enter", name, commandKeys: keys(command), template: typeof command?.template === "string" ? command.template.slice(0, 240) : undefined })',
    '          const result = Reflect.apply(mutate, this, [command, ...mutateRest])',
    '          trace({ phase: "command.mutate.after", name, commandKeys: keys(command), template: typeof command?.template === "string" ? command.template.slice(0, 240) : undefined, description: command?.description, subtask: command?.subtask })',
    '          return result',
    '        } : mutate',
    '        try { const result = Reflect.apply(original, targetDraft, [name, wrappedMutate, ...rest]); trace({ phase: "command.update.after", name, returnType: typeof result }); return result }',
    '        catch (error) { trace({ phase: "command.update.error", name, error: errorInfo(error) }); throw error }',
    '      }',
    '    },',
    '  })',
    '}',
    'function wrapToolDraft(draft) {',
    '  if (!draft || (typeof draft !== "object" && typeof draft !== "function")) return draft',
    '  return new Proxy(draft, {',
    '    get(targetDraft, prop, receiver) {',
    '      const original = Reflect.get(targetDraft, prop, receiver)',
    '      if (prop !== "add" || typeof original !== "function") return original',
    '      const wrappedAdd = function (...args) {',
    '        const first = args[0]',
    '        trace({ phase: "tool.add.before", observedLength: original.length, wrapperLength: wrappedAdd.length, argCount: args.length, firstType: typeof first, firstName: first?.name ?? (typeof first === "string" ? first : undefined), firstKeys: keys(first), codemode: first?.codemode })',
    '        try { const result = Reflect.apply(original, targetDraft, args); trace({ phase: "tool.add.after", firstName: first?.name ?? first, returnType: typeof result }); return result }',
    '        catch (error) { trace({ phase: "tool.add.error", error: errorInfo(error) }); throw error }',
    '      }',
    '      Object.defineProperty(wrappedAdd, "length", { value: original.length })',
    '      return wrappedAdd',
    '    },',
    '  })',
    '}',
    'function wrapTransform(domainName, domain, original) {',
    '  return async function (callback, ...rest) {',
    '    trace({ phase: `${domainName}.transform.register.before` })',
    '    const wrappedCallback = function (draft, ...callbackRest) {',
    '      trace({ phase: `${domainName}.transform.callback.enter`, draftKeys: keys(draft) })',
    '      const wrappedDraft = domainName === "command" ? wrapCommandDraft(draft) : wrapToolDraft(draft)',
    '      try {',
    '        const result = Reflect.apply(callback, this, [wrappedDraft, ...callbackRest])',
    '        if (result && typeof result.then === "function") return result.then((value) => { trace({ phase: `${domainName}.transform.callback.after`, async: true }); return value }, (error) => { trace({ phase: `${domainName}.transform.callback.error`, error: errorInfo(error) }); throw error })',
    '        trace({ phase: `${domainName}.transform.callback.after`, async: false })',
    '        return result',
    '      } catch (error) { trace({ phase: `${domainName}.transform.callback.error`, error: errorInfo(error) }); throw error }',
    '    }',
    '    try { const result = await Reflect.apply(original, domain, [wrappedCallback, ...rest]); trace({ phase: `${domainName}.transform.register.after` }); return result }',
    '    catch (error) { trace({ phase: `${domainName}.transform.register.error`, error: errorInfo(error) }); throw error }',
    '  }',
    '}',
    'function wrapSession(domain) {',
    '  return new Proxy(domain, {',
    '    get(targetDomain, prop, receiver) {',
    '      const original = Reflect.get(targetDomain, prop, receiver)',
    '      if (prop !== "hook" || typeof original !== "function") return original',
    '      return async function (name, callback, ...rest) {',
    '        trace({ phase: "session.hook.register.before", hook: name })',
    '        const wrappedCallback = function (event, ...callbackRest) {',
    '          trace({ phase: "session.hook.callback.enter", hook: name, event: eventShape(event) })',
    '          try {',
    '            const result = Reflect.apply(callback, this, [event, ...callbackRest])',
    '            if (result && typeof result.then === "function") return result.then((value) => { trace({ phase: "session.hook.callback.after", hook: name, event: eventShape(event), async: true }); return value }, (error) => { trace({ phase: "session.hook.callback.error", hook: name, error: errorInfo(error) }); throw error })',
    '            trace({ phase: "session.hook.callback.after", hook: name, event: eventShape(event), async: false })',
    '            return result',
    '          } catch (error) { trace({ phase: "session.hook.callback.error", hook: name, error: errorInfo(error) }); throw error }',
    '        }',
    '        try { const result = await Reflect.apply(original, targetDomain, [name, wrappedCallback, ...rest]); trace({ phase: "session.hook.register.after", hook: name }); return result }',
    '        catch (error) { trace({ phase: "session.hook.register.error", hook: name, error: errorInfo(error) }); throw error }',
    '      }',
    '    },',
    '  })',
    '}',
    'const diagnostic = {',
    '  id: target.id,',
    '  async setup(ctx) {',
    '    trace({ phase: "setup.enter", ctxKeys: keys(ctx), commandKeys: keys(ctx?.command), toolKeys: keys(ctx?.tool), sessionKeys: keys(ctx?.session) })',
    '    const wrappedCtx = new Proxy(ctx, {',
    '      get(targetCtx, prop, receiver) {',
    '        const value = Reflect.get(targetCtx, prop, receiver)',
    '        if ((prop === "command" || prop === "tool") && value && typeof value === "object") {',
    '          return new Proxy(value, { get(domain, method, domainReceiver) { const original = Reflect.get(domain, method, domainReceiver); return method === "transform" && typeof original === "function" ? wrapTransform(String(prop), domain, original) : original } })',
    '        }',
    '        if (prop === "session" && value && typeof value === "object") return wrapSession(value)',
    '        return value',
    '      },',
    '    })',
    '    try { const cleanup = await target.setup(wrappedCtx); trace({ phase: "setup.after" }); return cleanup }',
    '    catch (error) { trace({ phase: "setup.error", error: errorInfo(error) }); throw error }',
    '  },',
    '}',
    'export default diagnostic',
    '',
  ].join("\n")
}

async function readFailureLog(env) {
  for (const file of [path.join(env.XDG_DATA_HOME, "opencode", "log", "opencode.log"), path.join(env.XDG_STATE_HOME, "opencode", "log", "opencode.log")]) {
    try { return (await readFile(file, "utf8")).slice(-50_000) } catch {}
  }
  return ""
}

async function waitFor(predicate, description, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await predicate()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for ${description}`)
}

async function main() {
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-v2-behavior-"))
  const project = path.join(temp, "project")
  const home = path.join(temp, "home")
  const config = path.join(home, ".config")
  const data = path.join(home, ".local", "share")
  const state = path.join(home, ".local", "state")
  const pluginDirectory = path.join(project, ".opencode", "plugins")
  const pluginFile = path.join(root, "dist", "opencode2", "experimental.js")
  const traceFile = path.join(temp, "v2-runtime-callback-trace.jsonl")
  const provider = startProvider()
  const providerPort = await provider.listen()

  await Promise.all([mkdir(pluginDirectory, { recursive: true }), mkdir(config, { recursive: true }), mkdir(data, { recursive: true }), mkdir(state, { recursive: true })])
  await writeFile(path.join(pluginDirectory, "opencode-goals-v2-behavior.js"), diagnosticBridgeSource(pathToFileURL(pluginFile).href, traceFile))
  await writeFile(path.join(project, "README.md"), "# OpenCode 2 Goal behavior canary\n")
  await writeFile(path.join(project, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "canary/canary",
    provider: {
      canary: {
        npm: "@ai-sdk/openai-compatible",
        name: "Deterministic V2 Goal Behavior Canary",
        options: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "canary-key" },
        models: { canary: { name: "Deterministic V2 Goal Behavior Canary", limit: { context: 100000, output: 4096 } } },
      },
    },
    command: {
      goal: { template: DECLARED_COMMAND_TEMPLATE, description: "Declared Goal command for the OpenCode 2 behavior canary", agent: "build", subtask: false },
    },
  }, null, 2)}\n`)

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    XDG_STATE_HOME: state,
    OPENCODE_DB: path.join(data, "opencode", "opencode-v2-behavior.db"),
    OPENCODE_LOG_LEVEL: "DEBUG",
    CI: "true",
  }

  await run("git", ["init", "-q"], { cwd: project, env })
  await run("git", ["config", "user.name", "OpenCode Goals Canary"], { cwd: project, env })
  await run("git", ["config", "user.email", "opencode-goals-canary@example.invalid"], { cwd: project, env })
  await run("git", ["add", "."], { cwd: project, env })
  await run("git", ["commit", "-q", "-m", "initialize V2 behavior workspace"], { cwd: project, env })

  const locationQuery = `location%5Bdirectory%5D=${encodeURIComponent(project)}`
  const scoped = (pathname) => `${pathname}${pathname.includes("?") ? "&" : "?"}${locationQuery}`
  const api = async (method, pathname, dataValue) => {
    const args = ["api", method.toLowerCase(), scoped(pathname)]
    if (dataValue !== undefined) args.push("--data", JSON.stringify(dataValue))
    const result = await run("opencode2", args, { cwd: project, env, timeout: 90_000 })
    return String(result.stdout ?? "").trim() ? parseJSONOutput(result, `${method.toUpperCase()} ${pathname}`) : null
  }

  try {
    await run("opencode2", ["service", "stop"], { cwd: project, env, allowFailure: true, timeout: 20_000 })
    const version = String((await run("opencode2", ["--version"], { cwd: project, env, timeout: 30_000 })).stdout ?? "").trim()
    assert.ok(version)
    assert.ok(await api("get", "/api/health"))

    const commandCatalog = await waitFor(async () => {
      const response = await api("get", "/api/command")
      const items = response?.data ?? response
      return Array.isArray(items) ? items.find((item) => item?.name === "goal" || item?.id === "goal") ?? null : null
    }, "declared goal command")

    const createdPayload = await api("post", "/api/session", {
      title: "OpenCode Goals V2 current-beta behavior",
      agent: "build",
      model: { id: "canary", providerID: "canary" },
      location: { directory: project },
    })
    const session = createdPayload?.data ?? createdPayload
    const sessionID = String(session?.id ?? "")
    assert.ok(sessionID)
    assert.equal(path.resolve(session?.location?.directory ?? session?.directory), path.resolve(project))

    const commandPromise = api("post", `/api/session/${encodeURIComponent(sessionID)}/command`, {
      command: "goal",
      arguments: EXACT_ARGUMENTS,
      agent: "build",
      model: { id: "canary", providerID: "canary" },
    })

    await waitFor(() => provider.stats.chatRequests >= 2 ? true : null, "two provider requests", 20_000)
    await commandPromise

    const goal = await new GoalStore(project).load(sessionID)
    const runtimeTrace = await textIfPresent(traceFile)
    const first = provider.stats.observations[0] ?? {}
    const second = provider.stats.observations[1] ?? {}

    console.log(JSON.stringify({
      ok: Boolean(first.hasControl && first.hasGet && first.sawWrapper && goal?.objective === "real v2 goal behavior" && !second.hasControl),
      platform: process.platform,
      node: process.version,
      opencode2Version: version,
      sessionID,
      goalID: goal?.id ?? null,
      commandCatalog: { name: commandCatalog?.name ?? commandCatalog?.id ?? "goal", catalogShowsDeclaredTemplate: commandCatalog?.template === DECLARED_COMMAND_TEMPLATE },
      provider: provider.stats,
      runtimeTrace,
    }, null, 2))

    assert.equal(first.hasControl, true, "authorized /goal request did not expose control tool")
    assert.equal(first.hasGet, true, "V2 get tool was absent")
    assert.equal(first.sawWrapper, true, "command wrapper was absent")
    assert.equal(first.sawExactArguments, true, "exact arguments were absent")
    assert.equal(goal?.objective, "real v2 goal behavior", "Goal was not persisted")
    assert.deepEqual(goal?.constraints, ["no unrelated mutation"])
    assert.equal(second.hasControl, false, "consumed control capability replayed")
  } catch (error) {
    const runtimeTrace = await textIfPresent(traceFile)
    if (runtimeTrace) console.error(`OpenCode 2 runtime callback trace:\n${runtimeTrace}`)
    const logTail = await readFailureLog(env)
    if (logTail) console.error(`OpenCode 2 server log tail:\n${logTail}`)
    console.error(`V2 behavior provider observations:\n${JSON.stringify(provider.stats, null, 2)}`)
    throw error
  } finally {
    await run("opencode2", ["service", "stop"], { cwd: project, env, allowFailure: true, timeout: 20_000 }).catch(() => undefined)
    await provider.close().catch(() => undefined)
    await rm(temp, { recursive: true, force: true }).catch(() => undefined)
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
