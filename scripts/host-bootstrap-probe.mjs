import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import net from "node:net"
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const isWindows = process.platform === "win32"

function resolveOpenCodeBinary() {
  if (!isWindows) return path.join(root, "node_modules", ".bin", "opencode")
  const candidates = [
    path.join(root, "node_modules", "opencode-windows-x64", "bin", "opencode.exe"),
    path.join(root, "node_modules", "opencode-windows-x64-baseline", "bin", "opencode.exe"),
    path.join(root, "node_modules", "opencode-windows-arm64", "bin", "opencode.exe"),
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) throw new Error(`OpenCode native Windows binary was not installed. Checked: ${candidates.join(", ")}`)
  return found
}

const binary = resolveOpenCodeBinary()

function appendLog(current, chunk, limit = 50_000) {
  return (current + String(chunk)).slice(-limit)
}

async function port() {
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

async function runCli(args, { cwd, env, timeoutMs = 15_000 }) {
  return await new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env, windowsHide: true })
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
      finish(reject, new Error(`CLI timed out: opencode ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, timeoutMs)
    child.once("error", (error) => finish(reject, error))
    child.once("close", (code) => {
      if (code !== 0) {
        finish(reject, new Error(`CLI exited ${code}: opencode ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
        return
      }
      finish(resolve, { stdout, stderr })
    })
  })
}

async function waitForTcp(value, child, logs) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`clean probe server exited\n${logs()}`)
    const ok = await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port: value })
      socket.once("connect", () => { socket.destroy(); resolve(true) })
      socket.once("error", () => resolve(false))
      socket.setTimeout(400, () => { socket.destroy(); resolve(false) })
    })
    if (ok) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`clean probe server never became reachable\n${logs()}`)
}

async function fetchBootstrap(scoped, log) {
  let lastError
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(scoped, { signal: AbortSignal.timeout(15_000) })
      if (attempt > 1) console.log(`clean probe: lazy instance bootstrap recovered on attempt ${attempt}`)
      return response
    } catch (error) {
      lastError = error
      if (attempt === 2) break
      console.warn("clean probe: first lazy instance bootstrap request timed out; retrying once")
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  throw new Error(`clean instance bootstrap request failed after 2 bounded attempts: ${String(lastError)}\n${log()}`)
}

const workspace = await mkdtemp(path.join(os.tmpdir(), "opencode-clean-bootstrap-"))
const serverPort = await port()
const env = {
  ...process.env,
  OPENCODE_DISABLE_AUTOUPDATE: "true",
  OPENCODE_PRINT_LOGS: "1",
  OPENCODE_LOG_LEVEL: "DEBUG",
  OPENCODE_DB: ":memory:",
  OPENCODE_PURE: "true",
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
  OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
  OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
  OPENCODE_DISABLE_EMBEDDED_WEB_UI: "true",
  CI: "true",
}

try {
  const config = await runCli(["debug", "config"], { cwd: workspace, env })
  assert.match(config.stdout, /\{[\s\S]*\}/, `debug config returned no JSON\n${config.stdout}\n${config.stderr}`)
  console.log("clean probe: Config.Service resolved through `opencode debug config`")

  const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(serverPort)], {
    cwd: workspace,
    env,
    windowsHide: true,
  })
  let log = ""
  const append = (chunk) => { log = appendLog(log, chunk) }
  child.stdout?.on("data", append)
  child.stderr?.on("data", append)

  try {
    await waitForTcp(serverPort, child, () => log)
    console.log(`clean probe: server reachable using in-memory DB and runner HOME=${env.HOME ?? env.USERPROFILE ?? "unknown"}`)
    const scoped = `http://127.0.0.1:${serverPort}/session?directory=${encodeURIComponent(workspace)}`
    const response = await fetchBootstrap(scoped, () => log)
    const text = await response.text()
    assert.equal(response.status, 200, `clean instance bootstrap returned ${response.status}: ${text}\n${log}`)
    const parsed = JSON.parse(text)
    assert.ok(Array.isArray(parsed?.data ?? parsed), `clean session list was not an array: ${text}`)
    console.log("clean OpenCode instance bootstrap probe passed")
  } finally {
    child.kill()
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve()
      const timer = setTimeout(resolve, 2_000)
      child.once("close", () => { clearTimeout(timer); resolve() })
    })
  }
} finally {
  await rm(workspace, { recursive: true, force: true }).catch(() => undefined)
}
