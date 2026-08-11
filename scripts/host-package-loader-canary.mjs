import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { spawn } from "node:child_process"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

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

async function runCli(args, { cwd, env, timeoutMs = 30_000 }) {
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

function parseConfig(stdout) {
  const start = stdout.indexOf("{")
  const end = stdout.lastIndexOf("}")
  if (start < 0 || end < start) throw new Error(`debug config returned no JSON:\n${stdout}`)
  return JSON.parse(stdout.slice(start, end + 1))
}

const workspace = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-package-loader-"))
const home = path.join(workspace, ".home")
const packageSpec = pathToFileURL(root).href

try {
  await mkdir(home, { recursive: true })
  await writeFile(path.join(workspace, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    plugin: [packageSpec],
  }, null, 2)}\n`)

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DB: ":memory:",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
    OPENCODE_DISABLE_EMBEDDED_WEB_UI: "true",
    CI: "true",
  }

  const result = await runCli(["debug", "config"], { cwd: workspace, env })
  const config = parseConfig(result.stdout)

  assert.ok(Array.isArray(config.plugin), "resolved config did not retain a plugin list")
  assert.ok(config.plugin.includes(packageSpec), `resolved config did not retain package plugin spec ${packageSpec}`)
  assert.equal(config.command?.goal?.description, "Set or manage a persistent evidence-verified goal.")
  assert.equal(config.command?.goal?.template, "$ARGUMENTS")
  assert.doesNotMatch(result.stderr, /Plugin export is not a function/i)

  console.log("real OpenCode package loader resolved package.json ./server and registered /goal")
} finally {
  await rm(workspace, { recursive: true, force: true }).catch(() => undefined)
}
