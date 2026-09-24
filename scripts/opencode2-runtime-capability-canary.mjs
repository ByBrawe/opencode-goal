import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createGoal } from "../dist/domain/goal.js"
import { GoalStore } from "../dist/persistence/store.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const runtimeProbeFile = path.join(root, "scripts", "opencode2-runtime-probe-plugin.mjs")
const OPENCODE_BINARY = process.env.OPENCODE2_BINARY || "opencode2"
const SERVER_USERNAME = "opencode"
const SERVER_PASSWORD = "opencode-goal-v2-runtime-capabilities"

function appendLog(current, chunk, limit = 100_000) {
  return (current + String(chunk)).slice(-limit)
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
    if (child.exitCode !== null) throw new Error(`OpenCode 2 server exited before ready.\n${logs()}`)
    const connected = await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port })
      socket.once("connect", () => {
        socket.destroy()
        resolve(true)
      })
      socket.once("error", () => resolve(false))
      socket.setTimeout(500, () => {
        socket.destroy()
        resolve(false)
      })
    })
    if (connected) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for OpenCode 2 server on ${port}\n${logs()}`)
}

async function stopProcess(child, timeoutMs = 5_000) {
  if (!child || child.exitCode !== null) return
  child.kill("SIGTERM")
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve()
    const timer = setTimeout(resolve, timeoutMs)
    child.once("close", () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function waitFor(predicate, description, diagnostics, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for ${description}\n${await diagnostics()}`)
}

function streamText(res, sequence, text) {
  const id = `chatcmpl-goal-v2-runtime-${sequence}`
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
    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
  })
  send({
    id,
    object: "chat.completion.chunk",
    created,
    model: "canary",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 32, completion_tokens: 4, total_tokens: 36 },
  })
  res.end("data: [DONE]\n\n")
}

function startProvider() {
  const stats = { requests: [] }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if (req.method === "GET" && url.pathname.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({
        object: "list",
        data: [{ id: "canary", object: "model", owned_by: "canary" }],
      }))
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
    const sequence = stats.requests.length + 1
    const isCompaction = raw.includes("You MUST summarize the conversation above")
      || raw.includes("Update the existing checkpoint in the conversation above")
    stats.requests.push({
      sequence,
      isCompaction,
      messageCount: Array.isArray(body?.messages) ? body.messages.length : 0,
      toolCount: Array.isArray(body?.tools)
        ? body.tools.length
        : body?.tools && typeof body.tools === "object"
          ? Object.keys(body.tools).length
          : 0,
    })
    if (isCompaction) {
      streamText(res, sequence, [
        "## Objective",
        "- Preserve the exact-host runtime capability proof.",
        "",
        "## Requirements",
        "- Keep the runtime event and compaction boundaries deterministic.",
        "",
        "## Decisions",
        "- Use the exact OpenCode 2.0.11 event vocabulary.",
        "",
        "## Work State",
        "### Completed",
        "- Primary provider turn completed.",
        "### Active",
        "- Manual compaction capability proof.",
        "### Blocked",
        "- (none)",
        "",
        "## Next Move",
        "1. Continue the runtime capability canary.",
        "",
        "## Relevant Files",
        "- (none)",
        "",
        "## Important Context",
        "- This is deterministic canary output.",
      ].join("\n"))
      return
    }
    streamText(res, sequence, `RUNTIME_CAPABILITY_TURN_${sequence}_OK`)
  })

  return {
    stats,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", resolve)
      })
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("deterministic provider did not bind")
      return address.port
    },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
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

async function main() {
  assert.equal(process.platform, "linux", "the exact OpenCode 2 runtime capability canary is intentionally Ubuntu-only")

  const workspace = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-v2-runtime-"))
  const home = path.join(workspace, ".home")
  const pluginDir = path.join(workspace, ".opencode", "plugins")
  const traceFile = path.join(workspace, "runtime-trace.jsonl")
  const provider = startProvider()
  const providerPort = await provider.listen()

  let server
  let serverLog = ""
  let apiPrefix = null
  let sessionID = ""

  await Promise.all([
    mkdir(pluginDir, { recursive: true }),
    mkdir(path.join(home, ".config"), { recursive: true }),
    mkdir(path.join(home, ".local", "share"), { recursive: true }),
    mkdir(path.join(home, ".local", "state"), { recursive: true }),
    mkdir(path.join(home, ".cache"), { recursive: true }),
  ])

  await writeFile(
    path.join(pluginDir, "opencode-goal-v2-runtime-probe.js"),
    `export { default } from ${JSON.stringify(pathToFileURL(runtimeProbeFile).href)}\n`,
    "utf8",
  )
  await writeFile(path.join(workspace, "README.md"), "# OpenCode Goal V2 runtime capability canary\n", "utf8")
  await writeFile(path.join(workspace, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "canary/canary",
    providers: {
      canary: {
        name: "Deterministic OpenCode Goal V2 Runtime Canary",
        package: "@opencode-ai/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${providerPort}/v1` },
        models: {
          canary: {
            name: "Deterministic OpenCode Goal V2 Runtime Canary",
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            limit: { context: 100000, output: 4096 },
          },
        },
      },
    },
  }, null, 2)}\n`, "utf8")

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
    OPENCODE_GOAL_V2_RUNTIME_TRACE: traceFile,
    OPENCODE_SERVER_USERNAME: SERVER_USERNAME,
    OPENCODE_SERVER_PASSWORD: SERVER_PASSWORD,
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    CI: "true",
  }

  const diagnostics = async () => {
    const trace = await readTrace(traceFile)
    return [
      `apiPrefix=${String(apiPrefix)}`,
      `sessionID=${sessionID || "none"}`,
      `provider=${JSON.stringify(provider.stats)}`,
      `trace=${JSON.stringify(trace.slice(-100))}`,
      `serverExit=${server?.exitCode}`,
      `serverLog=${serverLog}`,
    ].join("\n")
  }

  try {
    const version = String(execFileSync(OPENCODE_BINARY, ["--version"], {
      cwd: workspace,
      env,
      encoding: "utf8",
      windowsHide: true,
    })).trim()
    assert.ok(version.includes("2.0.11"), `expected exact OpenCode 2.0.11, got: ${version}`)

    const port = await reservePort()
    server = spawn(OPENCODE_BINARY, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: workspace,
      env,
      windowsHide: true,
    })
    server.stdout?.on("data", (chunk) => { serverLog = appendLog(serverLog, chunk) })
    server.stderr?.on("data", (chunk) => { serverLog = appendLog(serverLog, chunk) })
    await waitForTcp(port, server, () => serverLog)

    const baseURL = `http://127.0.0.1:${port}`
    const authorization = `Basic ${Buffer.from(`${SERVER_USERNAME}:${SERVER_PASSWORD}`).toString("base64")}`
    const request = async (pathname, init = {}, timeoutMs = 30_000) => {
      const response = await fetch(`${baseURL}${pathname}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          "x-opencode-directory": workspace,
          authorization,
          ...(init.headers ?? {}),
        },
        signal: init.signal ?? AbortSignal.timeout(timeoutMs),
      })
      const text = await response.text()
      let body = null
      if (text) {
        try { body = JSON.parse(text) } catch { body = text }
      }
      return { ok: response.ok, status: response.status, body, text }
    }

    for (const prefix of ["/api", ""]) {
      const response = await request(`${prefix}/command`, { method: "GET" }, 10_000).catch(() => null)
      if (response?.ok) {
        apiPrefix = prefix
        break
      }
    }
    assert.notEqual(apiPrefix, null, `OpenCode 2 API never became ready\n${await diagnostics()}`)

    await waitFor(async () => {
      const trace = await readTrace(traceFile)
      return trace.some((item) => item.phase === "event.subscribe.registered")
        && trace.some((item) => item.phase === "session.compaction.registered")
    }, "runtime event and compaction hook registration", diagnostics, 30_000)

    const created = await request(`${apiPrefix}/session`, {
      method: "POST",
      body: JSON.stringify({ title: "OpenCode Goal V2 runtime capability" }),
    })
    assert.ok(created.ok, `session create failed: HTTP ${created.status} ${created.text}\n${await diagnostics()}`)
    sessionID = String((created.body?.data ?? created.body)?.id ?? "")
    assert.ok(sessionID, `session ID missing: ${created.text}`)

    const goalStore = new GoalStore(workspace)
    await goalStore.save(createGoal({
      sessionID,
      objective: "prove exact OpenCode 2 successful-execution autonomous continuation parity",
    }))

    const prompt = await request(`${apiPrefix}/session/${encodeURIComponent(sessionID)}/prompt`, {
      method: "POST",
      body: JSON.stringify({
        text: "start exact OpenCode 2 Goal-owned continuation proof",
        delivery: "steer",
        resume: true,
      }),
    }, 120_000)
    assert.ok(prompt.ok, `initial runtime prompt failed: HTTP ${prompt.status} ${prompt.text}\n${await diagnostics()}`)

    await waitFor(
      () => provider.stats.requests.filter((item) => !item.isCompaction).length >= 3,
      "initial provider turn plus two Goal-owned V2 continuations",
      diagnostics,
      120_000,
    )

    const thirdNoProgress = await waitFor(async () => {
      const goal = await goalStore.load(sessionID)
      return goal?.status === "paused" && goal.stalledTurns === 3 ? goal : null
    }, "persisted V2 no-progress pause after autonomous continuations", diagnostics, 120_000)
    assert.match(thirdNoProgress.stopReason ?? "", /3 continuation turns without host-observed progress/)

    const autonomousTrace = await readTrace(traceFile)
    const closedTurns = autonomousTrace
      .filter((item) => item.phase === "goal.execution.boundary.closed" && item.sessionID === sessionID)
      .map((item) => item.stalledTurns)
    assert.deepEqual(closedTurns.slice(0, 3), [1, 2, 3], `unexpected Goal boundary sequence\n${await diagnostics()}`)

    const scheduledContinuations = autonomousTrace.filter((item) =>
      item.phase === "goal.continuation.scheduled" && item.sessionID === sessionID
    )
    const dispatchedContinuations = autonomousTrace.filter((item) =>
      item.phase === "goal.continuation.dispatched" && item.sessionID === sessionID
    )
    assert.equal(scheduledContinuations.length, 2, "only the two still-active successful boundaries may schedule continuation")
    assert.equal(dispatchedContinuations.length, 2, "the probe must dispatch exactly two Goal-owned continuations")

    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(
      provider.stats.requests.filter((item) => !item.isCompaction).length,
      3,
      "paused third boundary must not dispatch a fourth Goal turn",
    )

    const compactionGoal = {
      ...thirdNoProgress,
      status: "active",
      stalledTurns: 2,
      observedProgressRevision: thirdNoProgress.progressRevision,
      updatedAt: Date.now(),
    }
    delete compactionGoal.stopReason
    await goalStore.save(compactionGoal)

    const beforeCompaction = await goalStore.load(sessionID)
    assert.equal(beforeCompaction?.status, "active")
    assert.equal(beforeCompaction?.stalledTurns, 2)
    const providerTurnsBeforeCompaction = provider.stats.requests.filter((item) => !item.isCompaction).length
    const compactionRequestsBefore = provider.stats.requests.filter((item) => item.isCompaction).length

    const compact = await request(`${apiPrefix}/session/${encodeURIComponent(sessionID)}/compact`, {
      method: "POST",
      body: JSON.stringify({}),
    }, 30_000)
    assert.ok(compact.ok, `manual compaction admission failed: HTTP ${compact.status} ${compact.text}\n${await diagnostics()}`)

    await waitFor(async () => {
      const trace = await readTrace(traceFile)
      return trace.some((item) => item.phase === "session.compaction" && item.sessionID === sessionID)
    }, "session.compaction hook on a real manual compaction", diagnostics, 60_000)

    await waitFor(async () => {
      const trace = await readTrace(traceFile)
      return trace.some((item) =>
        item.phase === "event"
        && item.sessionID === sessionID
        && (
          item.type === "session.compaction.ended"
          || item.type === "session.compacted"
        )
      )
    }, "terminal compaction event through ctx.event.subscribe()", diagnostics, 60_000)

    const compactionReady = await waitFor(async () => {
      const trace = await readTrace(traceFile)
      return trace.find((item) =>
        item.phase === "goal.compaction.continuation.ready"
        && item.sessionID === sessionID
      )
    }, "active Goal post-compaction continuation boundary", diagnostics, 60_000)
    assert.equal(compactionReady.status, "active")
    assert.equal(compactionReady.stalledTurns, 2, "compaction execution must not count as a no-progress Goal turn")
    assert.equal(compactionReady.shouldContinue, true)

    await waitFor(async () => {
      const trace = await readTrace(traceFile)
      return trace.some((item) =>
        item.phase === "goal.continuation.dispatched"
        && item.sessionID === sessionID
        && item.source === "compaction"
      )
    }, "one Goal-owned post-compaction continuation dispatch", diagnostics, 60_000)

    await waitFor(
      () => provider.stats.requests.filter((item) => !item.isCompaction).length === providerTurnsBeforeCompaction + 1,
      "exactly one non-compaction provider turn after active Goal compaction",
      diagnostics,
      60_000,
    )

    const afterCompactionContinuation = await waitFor(async () => {
      const goal = await goalStore.load(sessionID)
      return goal?.status === "paused" && goal.stalledTurns === 3 ? goal : null
    }, "post-compaction Goal continuation settles through normal no-progress boundary", diagnostics, 60_000)

    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(
      provider.stats.requests.filter((item) => !item.isCompaction).length,
      providerTurnsBeforeCompaction + 1,
      "paused post-compaction Goal must not dispatch a duplicate continuation",
    )
    assert.equal(
      provider.stats.requests.filter((item) => item.isCompaction).length,
      compactionRequestsBefore + 1,
      "manual compaction must consume exactly one compaction provider request",
    )

    const restartGoal = {
      ...afterCompactionContinuation,
      status: "active",
      stalledTurns: 2,
      observedProgressRevision: afterCompactionContinuation.progressRevision,
      updatedAt: Date.now(),
    }
    delete restartGoal.stopReason
    await goalStore.save(restartGoal)

    const beforeRestart = await goalStore.load(sessionID)
    assert.equal(beforeRestart?.status, "active")
    assert.equal(beforeRestart?.stalledTurns, 2)
    const restartProviderTurnsBefore = provider.stats.requests.filter((item) => !item.isCompaction).length
    const setupCountBeforeRestart = (await readTrace(traceFile)).filter((item) => item.phase === "setup").length

    await stopProcess(server)
    serverLog = ""
    server = spawn(OPENCODE_BINARY, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: workspace,
      env: {
        ...env,
        OPENCODE_GOAL_V2_RUNTIME_RESTART_SESSION: sessionID,
      },
      windowsHide: true,
    })
    server.stdout?.on("data", (chunk) => { serverLog = appendLog(serverLog, chunk) })
    server.stderr?.on("data", (chunk) => { serverLog = appendLog(serverLog, chunk) })
    await waitForTcp(port, server, () => serverLog)

    await waitFor(async () => {
      const current = await readTrace(traceFile)
      return current.filter((item) => item.phase === "setup").length > setupCountBeforeRestart
        && current.some((item) =>
          item.phase === "goal.restart.continuation.ready"
          && item.sessionID === sessionID
          && item.status === "active"
          && item.stalledTurns === 2
          && item.shouldContinue === true
        )
    }, "restart probe reloads the active persisted Goal without closing the interrupted turn", diagnostics, 60_000)

    await waitFor(async () => {
      const current = await readTrace(traceFile)
      return current.some((item) =>
        item.phase === "goal.continuation.dispatched"
        && item.sessionID === sessionID
        && item.source === "restart"
      )
    }, "one Goal-owned restart continuation dispatch", diagnostics, 60_000)

    await waitFor(
      () => provider.stats.requests.filter((item) => !item.isCompaction).length === restartProviderTurnsBefore + 1,
      "exactly one provider turn after OpenCode 2 process restart",
      diagnostics,
      60_000,
    )

    const afterRestartContinuation = await waitFor(async () => {
      const goal = await goalStore.load(sessionID)
      return goal?.status === "paused" && goal.stalledTurns === 3 ? goal : null
    }, "restart continuation settles through the normal successful execution boundary", diagnostics, 60_000)
    assert.equal(afterRestartContinuation.id, beforeRestart.id, "restart recovery must preserve Goal identity")
    assert.equal(afterRestartContinuation.revision, beforeRestart.revision, "restart recovery must preserve Goal revision")
    assert.equal(afterRestartContinuation.progressRevision, beforeRestart.progressRevision, "restart recovery must not invent progress")

    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(
      provider.stats.requests.filter((item) => !item.isCompaction).length,
      restartProviderTurnsBefore + 1,
      "paused restart-recovered Goal must not dispatch a duplicate continuation",
    )

    const trace = await readTrace(traceFile)
    assert.ok(
      trace.some((item) => item.phase === "session.context" && item.sessionID === sessionID),
      `session.context did not fire for the primary provider turn\n${await diagnostics()}`,
    )
    assert.ok(
      !trace.some((item) => item.phase === "event.subscribe.error"),
      `ctx.event.subscribe() reported an error\n${await diagnostics()}`,
    )

    const sessionEvents = trace.filter((item) => item.phase === "event" && item.sessionID === sessionID)
    console.log(JSON.stringify({
      ok: true,
      version,
      apiPrefix,
      sessionID,
      providerRequests: provider.stats.requests.length,
      compactionHookRegistered: true,
      compactionHookObserved: trace.some((item) => item.phase === "session.compaction" && item.sessionID === sessionID),
      compactionEndedObserved: sessionEvents.some((item) => item.type === "session.compaction.ended"),
      compactionFailedObserved: sessionEvents.some((item) => item.type === "session.compaction.failed"),
      compactionTerminalType: sessionEvents.find((item) =>
        item.type === "session.compaction.ended"
        || item.type === "session.compacted"
      )?.type,
      legacyCompactedEventObserved: sessionEvents.some((item) => item.type === "session.compacted"),
      contextHookObserved: true,
      eventTypes: [...new Set(sessionEvents.map((item) => item.type).filter(Boolean))],
      terminalEventObserved: sessionEvents.some((item) =>
        item.type === "session.execution.succeeded"
        || item.type === "session.idle"
        || (item.type === "session.status" && (item.status?.type === "idle" || item.status === "idle"))
      ),
      executionSucceededObserved: sessionEvents.some((item) => item.type === "session.execution.succeeded"),
      successfulExecutionCount: sessionEvents.filter((item) => item.type === "session.execution.succeeded").length,
      noProgressBoundary: {
        status: thirdNoProgress.status,
        stalledTurns: thirdNoProgress.stalledTurns,
        stopReason: thirdNoProgress.stopReason,
      },
      autonomousContinuation: {
        scheduled: scheduledContinuations.length,
        dispatched: dispatchedContinuations.length,
        providerTurnsBeforeCompaction,
      },
      activeCompactionContinuation: {
        readyStatus: compactionReady.status,
        stalledTurnsBeforeContinuation: compactionReady.stalledTurns,
        postContinuationStatus: afterCompactionContinuation.status,
        postContinuationStalledTurns: afterCompactionContinuation.stalledTurns,
        compactionScheduled: trace.filter((item) =>
          item.phase === "goal.continuation.scheduled"
          && item.sessionID === sessionID
          && item.source === "compaction"
        ).length,
        compactionDispatched: trace.filter((item) =>
          item.phase === "goal.continuation.dispatched"
          && item.sessionID === sessionID
          && item.source === "compaction"
        ).length,
        providerTurnsAfterCompaction: provider.stats.requests.filter((item) => !item.isCompaction).length - providerTurnsBeforeCompaction,
      },
      restartRecovery: {
        setupCount: trace.filter((item) => item.phase === "setup").length,
        ready: trace.filter((item) =>
          item.phase === "goal.restart.continuation.ready"
          && item.sessionID === sessionID
        ).length,
        dispatched: trace.filter((item) =>
          item.phase === "goal.continuation.dispatched"
          && item.sessionID === sessionID
          && item.source === "restart"
        ).length,
        persistedStatus: afterRestartContinuation.status,
        stalledTurnsAfterRecovery: afterRestartContinuation.stalledTurns,
        providerTurnsAfterRestart: provider.stats.requests.filter((item) => !item.isCompaction).length - restartProviderTurnsBefore,
      },
    }, null, 2))
  } finally {
    await stopProcess(server)
    await provider.close().catch(() => {})
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
