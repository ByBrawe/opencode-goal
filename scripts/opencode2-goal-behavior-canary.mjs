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
    return content.map((part) => {
      if (typeof part === "string") return part
      return part?.text ?? part?.content ?? part?.output ?? ""
    }).join("\n")
  }).join("\n")
}

function toolNames(body) {
  if (Array.isArray(body?.tools)) {
    return body.tools.map((item) => item?.function?.name ?? item?.name).filter((item) => typeof item === "string")
  }
  return body?.tools && typeof body.tools === "object" ? Object.keys(body.tools) : []
}

function beginStream(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
}

function send(res, value) {
  res.write(`data: ${JSON.stringify(value)}\n\n`)
}

function streamToolCall(res, id, created) {
  beginStream(res)
  send(res, {
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
  send(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model: "canary",
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ arguments: EXACT_ARGUMENTS }) } }] },
      finish_reason: null,
    }],
  })
  send(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model: "canary",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 48, completion_tokens: 12, total_tokens: 60 },
  })
  res.end("data: [DONE]\n\n")
}

function streamText(res, id, created) {
  beginStream(res)
  send(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model: "canary",
    choices: [{ index: 0, delta: { role: "assistant", content: "V2_GOAL_CONTROL_DONE" }, finish_reason: null }],
  })
  send(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model: "canary",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 40, completion_tokens: 5, total_tokens: 45 },
  })
  res.end("data: [DONE]\n\n")
}

function startProvider() {
  const stats = {
    chatRequests: 0,
    firstControlExposed: false,
    firstGetExposed: false,
    transformedWrapperSeen: false,
    exactArgumentsSeen: false,
    postToolControlExposed: false,
    paths: [],
    observations: [],
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
    const names = toolNames(body)
    const text = messageText(body)
    const request = ++stats.chatRequests
    const hasControl = names.includes(CONTROL_TOOL)
    const hasGet = names.includes(GET_TOOL)
    const sawWrapper = text.includes(COMMAND_WRAPPER_TEXT)
    const sawExactArguments = text.includes(EXACT_ARGUMENTS)
    stats.observations.push({ request, tools: names, hasControl, hasGet, sawWrapper, sawExactArguments })

    const id = `chatcmpl-v2-goal-${request}`
    const created = Math.floor(Date.now() / 1000)
    if (request === 1) {
      stats.firstControlExposed = hasControl
      stats.firstGetExposed = hasGet
      stats.transformedWrapperSeen = sawWrapper
      stats.exactArgumentsSeen = sawExactArguments
      streamToolCall(res, id, created)
      return
    }
    stats.postToolControlExposed ||= hasControl
    streamText(res, id, created)
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
    'function trace(event) { appendFileSync(traceFile, `${JSON.stringify({ at: Date.now(), ...event })}\\n`, "utf8") }',
    'function err(error) { return { name: error?.name ?? typeof error, message: error?.message ?? String(error) } }',
    'function keys(value) { return value && (typeof value === "object" || typeof value === "function") ? Reflect.ownKeys(value).map(String).slice(0, 40) : [] }',
    'function template(value) { return typeof value?.template === "string" ? value.template.slice(0, 240) : undefined }',
    'function eventShape(value) {',
    '  const request = value?.request && typeof value.request === "object" ? value.request : undefined',
    '  return {',
    '    keys: keys(value),',
    '    requestKeys: keys(request),',
    '    sessionID: value?.sessionID ?? request?.sessionID ?? request?.session?.id,',
    '    agent: value?.agent ?? value?.agentID ?? request?.agent ?? request?.agent?.id,',
    '    messagesType: Array.isArray(value?.messages) ? `array:${value.messages.length}` : typeof value?.messages,',
    '    toolsType: value?.tools && typeof value.tools === "object" ? `object:${Object.keys(value.tools).slice(0, 30).join(",")}` : typeof value?.tools,',
    '    systemType: Array.isArray(value?.system) ? `array:${value.system.length}` : typeof value?.system,',
    '  }',
    '}',
    'function wrapCommandDraft(draft) {',
    '  if (!draft || (typeof draft !== "object" && typeof draft !== "function")) return draft',
    '  return new Proxy(draft, {',
    '    get(targetDraft, prop, receiver) {',
    '      const original = Reflect.get(targetDraft, prop, receiver)',
    '      if (prop !== "update" || typeof original !== "function") return original',
    '      return function (...args) {',
    '        trace({ phase: "command.update.before", name: args[0], updateLength: original.length, updateSource: Function.prototype.toString.call(original).slice(0, 500) })',
    '        const mutate = args[1]',
    '        const callArgs = typeof mutate === "function" ? [args[0], function (command, ...rest) {',
    '          trace({ phase: "command.mutate.enter", commandKeys: keys(command), template: template(command), description: command?.description, agent: command?.agent, subtask: command?.subtask })',
    '          try {',
    '            const result = Reflect.apply(mutate, this, [command, ...rest])',
    '            trace({ phase: "command.mutate.after", commandKeys: keys(command), template: template(command), description: command?.description, agent: command?.agent, subtask: command?.subtask, returnType: typeof result })',
    '            return result',
    '          } catch (error) { trace({ phase: "command.mutate.error", error: err(error) }); throw error }',
    '        }, ...args.slice(2)] : args',
    '        try {',
    '          const result = Reflect.apply(original, targetDraft, callArgs)',
    '          trace({ phase: "command.update.after", name: args[0], returnType: typeof result })',
    '          return result',
    '        } catch (error) { trace({ phase: "command.update.error", name: args[0], error: err(error) }); throw error }',
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
    '      return function (...args) {',
    '        const first = args[0]',
    '        trace({ phase: "tool.add.before", addLength: original.length, argCount: args.length, firstType: typeof first, firstName: first?.name ?? (typeof first === "string" ? first : undefined), firstKeys: keys(first), codemode: first?.codemode })',
    '        try { const result = Reflect.apply(original, targetDraft, args); trace({ phase: "tool.add.after", firstName: first?.name ?? first, returnType: typeof result }); return result }',
    '        catch (error) { trace({ phase: "tool.add.error", error: err(error) }); throw error }',
    '      }',
    '    },',
    '  })',
    '}',
    'function wrapTransform(domainName, domain, original) {',
    '  return async function (callback, ...rest) {',
    '    trace({ phase: `${domainName}.transform.register.before`, callbackType: typeof callback })',
    '    const wrapped = function (draft, ...callbackRest) {',
    '      trace({ phase: `${domainName}.transform.callback.enter`, draftKeys: keys(draft) })',
    '      const wrappedDraft = domainName === "command" ? wrapCommandDraft(draft) : wrapToolDraft(draft)',
    '      try {',
    '        const result = Reflect.apply(callback, this, [wrappedDraft, ...callbackRest])',
    '        if (result && typeof result.then === "function") return result.then((value) => { trace({ phase: `${domainName}.transform.callback.after`, async: true }); return value }, (error) => { trace({ phase: `${domainName}.transform.callback.error`, error: err(error) }); throw error })',
    '        trace({ phase: `${domainName}.transform.callback.after`, async: false })',
    '        return result',
    '      } catch (error) { trace({ phase: `${domainName}.transform.callback.error`, error: err(error) }); throw error }',
    '    }',
    '    try { const result = await Reflect.apply(original, domain, [wrapped, ...rest]); trace({ phase: `${domainName}.transform.register.after` }); return result }',
    '    catch (error) { trace({ phase: `${domainName}.transform.register.error`, error: err(error) }); throw error }',
    '  }',
    '}',
    'function wrapSession(domain) {',
    '  return new Proxy(domain, {',
    '    get(targetDomain, prop, receiver) {',
    '      const original = Reflect.get(targetDomain, prop, receiver)',
    '      if (prop !== "hook" || typeof original !== "function") return original',
    '      return async function (name, callback, ...rest) {',
    '        trace({ phase: "session.hook.register.before", hook: name, callbackType: typeof callback })',
    '        const wrapped = function (event, ...callbackRest) {',
    '          trace({ phase: "session.hook.callback.enter", hook: name, event: eventShape(event) })',
    '          try {',
    '            const result = Reflect.apply(callback, this, [event, ...callbackRest])',
    '            if (result && typeof result.then === "function") return result.then((value) => { trace({ phase: "session.hook.callback.after", hook: name, event: eventShape(event), async: true }); return value }, (error) => { trace({ phase: "session.hook.callback.error", hook: name, error: err(error) }); throw error })',
    '            trace({ phase: "session.hook.callback.after", hook: name, event: eventShape(event), async: false })',
    '            return result',
    '          } catch (error) { trace({ phase: "session.hook.callback.error", hook: name, error: err(error) }); throw error }',
    '        }',
    '        try { const result = await Reflect.apply(original, targetDomain, [name, wrapped, ...rest]); trace({ phase: "session.hook.register.after", hook: name }); return result }',
    '        catch (error) { trace({ phase: "session.hook.register.error", hook: name, error: err(error) }); throw error }',
    '      }',
    '    },',
    '  })',
    '}',
    'const diagnostic = {',
    '  id: target.id,',
    '  async setup(ctx) {',
    '    trace({ phase: "setup.enter", ctxKeys: keys(ctx), domains: { command: keys(ctx?.command), tool: keys(ctx?.tool), session: keys(ctx?.session) } })',
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
    '    catch (error) { trace({ phase: "setup.error", error: err(error) }); throw error }',
    '  },',
    '}',
    'export default diagnostic',
    '',
  ].join("\n")
}

async function readFailureLog(env) {
  for (const file of [
    path.join(env.XDG_DATA_HOME, "opencode", "log", "opencode.log"),
    path.join(env.XDG_STATE_HOME, "opencode", "log", "opencode.log"),
  ]) {
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

  await Promise.all([
    mkdir(pluginDirectory, { recursive: true }),
    mkdir(config, { recursive: true }),
    mkdir(data, { recursive: true }),
    mkdir(state, { recursive: true }),
  ])
  await writeFile(
    path.join(pluginDirectory, "opencode-goals-v2-behavior.js"),
    diagnosticBridgeSource(pathToFileURL(pluginFile).href, traceFile),
  )
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
      goal: {
        template: DECLARED_COMMAND_TEMPLATE,
        description: "Declared Goal command for the OpenCode 2 behavior canary",
        agent: "build",
        subtask: false,
      },
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
    assert.ok(version, "opencode2 --version returned no output")
    assert.ok(await api("get", "/api/health"), "OpenCode 2 health API returned no payload")

    const commandCatalog = await waitFor(async () => {
      const response = await api("get", "/api/command")
      const items = response?.data ?? response
      return Array.isArray(items) ? items.find((item) => item?.name === "goal" || item?.id === "goal") ?? null : null
    }, "declared goal command to enter the beta command catalog")

    const createdPayload = await api("post", "/api/session", {
      title: "OpenCode Goals V2 current-beta behavior",
      agent: "build",
      model: { id: "canary", providerID: "canary" },
      location: { directory: project },
    })
    const session = createdPayload?.data ?? createdPayload
    const sessionID = String(session?.id ?? "")
    assert.ok(sessionID, `OpenCode 2 did not create a session: ${JSON.stringify(createdPayload)}`)
    const sessionDirectory = session?.location?.directory ?? session?.directory
    assert.equal(path.resolve(sessionDirectory), path.resolve(project), `OpenCode 2 created the behavior session outside the project Location: ${JSON.stringify(createdPayload)}`)

    const commandPromise = api("post", `/api/session/${encodeURIComponent(sessionID)}/command`, {
      command: "goal",
      arguments: EXACT_ARGUMENTS,
      agent: "build",
      model: { id: "canary", providerID: "canary" },
    })

    await waitFor(() => provider.stats.chatRequests >= 2 ? true : null, "post-tool provider request", 20_000)
    await commandPromise

    const goal = await new GoalStore(project).load(sessionID)
    const runtimeTrace = await textIfPresent(traceFile)

    assert.equal(provider.stats.firstControlExposed, true, `authorized real /goal request did not expose the request-scoped control tool; trace:\n${runtimeTrace ?? "<none>"}`)
    assert.equal(provider.stats.firstGetExposed, true, `registered V2 read tool was absent from the real provider request; trace:\n${runtimeTrace ?? "<none>"}`)
    assert.equal(provider.stats.transformedWrapperSeen, true, `real command.transform path did not deliver the V2 command wrapper; trace:\n${runtimeTrace ?? "<none>"}`)
    assert.equal(provider.stats.exactArgumentsSeen, true, "real command transport did not preserve the exact raw /goal arguments")
    assert.equal(goal?.objective, "real v2 goal behavior", `exact V2 control did not persist the Goal; trace:\n${runtimeTrace ?? "<none>"}`)
    assert.deepEqual(goal?.constraints, ["no unrelated mutation"])
    assert.equal(provider.stats.postToolControlExposed, false, `consumed V2 control capability was re-exposed after the tool call: ${JSON.stringify(provider.stats.observations)}`)

    console.log(JSON.stringify({
      ok: true,
      platform: process.platform,
      node: process.version,
      opencode2Version: version,
      sessionID,
      goalID: goal?.id ?? null,
      commandCatalog: {
        name: commandCatalog?.name ?? commandCatalog?.id ?? "goal",
        catalogShowsDeclaredTemplate: commandCatalog?.template === DECLARED_COMMAND_TEMPLATE,
      },
      provider: provider.stats,
      runtimeTrace,
    }, null, 2))
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
