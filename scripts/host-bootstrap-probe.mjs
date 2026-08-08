import assert from "node:assert/strict"
import net from "node:net"
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const isWindows = process.platform === "win32"
const binary = path.join(root, "node_modules", ".bin", isWindows ? "opencode.cmd" : "opencode")

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
    const child = spawn(binary, args, { cwd, env, shell: isWindows, windowsHide: true })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk) => { stdout = appendLog(stdout, chunk) })
    child.stderr?.on("data", (chunk) => { stderr = appendLog(stderr, chunk) })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`CLI timed out: opencode ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, timeoutMs)
    child.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once("close", (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`CLI exited ${code}: opencode ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
        return
      }
      resolve({ stdout, stderr })
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
    shell: isWindows,
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
    const response = await fetch(scoped, { signal: AbortSignal.timeout(15_000) }).catch((error) => {
      throw new Error(`clean instance bootstrap request failed after Config.Service succeeded: ${String(error)}\n${log}`)
    })
    const text = await response.text()
    assert.equal(response.status, 200, `clean instance bootstrap returned ${response.status}: ${text}\n${log}`)
    const parsed = JSON.parse(text)
    assert.ok(Array.isArray(parsed?.data ?? parsed), `clean session list was not an array: ${text}`)
    console.log("clean OpenCode instance bootstrap probe passed")
  } finally {
    child.kill()
  }
} finally {
  await rm(workspace, { recursive: true, force: true }).catch(() => undefined)
}
