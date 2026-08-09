import { spawn, spawnSync } from "node:child_process"
import path from "node:path"
import process from "node:process"
import { SECRET_NAME_PATTERN } from "./manifest.mjs"

const OUTPUT_TAIL_LIMIT = 20_000
const BASE_ENV_KEYS = process.platform === "win32"
  ? ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP"]
  : ["PATH", "LANG", "LC_ALL", "TERM", "TMPDIR"]

export function safeChildEnv({ home, passEnv = [], extra = {} }) {
  const env = {}
  for (const key of BASE_ENV_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key]
  env.HOME = home
  if (process.platform === "win32") env.USERPROFILE = home
  env.XDG_CONFIG_HOME = path.join(home, ".config")
  env.XDG_DATA_HOME = path.join(home, ".local", "share")
  env.XDG_STATE_HOME = path.join(home, ".local", "state")
  env.FORCE_COLOR = "0"
  env.NO_COLOR = "1"
  env.CI = "1"
  for (const key of passEnv) if (process.env[key] !== undefined) env[key] = process.env[key]
  for (const [key, value] of Object.entries(extra)) env[key] = String(value)
  return env
}

export function collectRedactions(manifest, competitor, env) {
  const names = new Set([...(manifest.passEnv ?? []), ...(manifest.redactEnv ?? [])])
  for (const source of [manifest.env ?? {}, competitor.env ?? {}]) {
    for (const key of Object.keys(source)) if (SECRET_NAME_PATTERN.test(key)) names.add(key)
  }
  const redactions = []
  const seenValues = new Set()
  for (const name of names) {
    const value = env[name]
    if (typeof value !== "string" || value.length < 4 || seenValues.has(value)) continue
    seenValues.add(value)
    redactions.push({ name, value })
  }
  return redactions.sort((a, b) => b.value.length - a.value.length)
}

export function redactText(value, redactions) {
  let result = String(value ?? "")
  for (const { name, value: secret } of redactions ?? []) {
    if (secret) result = result.split(secret).join(`[REDACTED:${name}]`)
  }
  return result
}

function appendTail(current, chunk) {
  const next = `${current}${chunk}`
  return next.length > OUTPUT_TAIL_LIMIT ? next.slice(-OUTPUT_TAIL_LIMIT) : next
}

function terminateProcessTree(child) {
  if (!child?.pid) return
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", shell: false, windowsHide: true })
    return
  }
  try {
    process.kill(-child.pid, "SIGKILL")
  } catch {
    try { child.kill("SIGKILL") } catch {}
  }
}

export function runCommand(command, options) {
  return new Promise((resolve) => {
    const started = performance.now()
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let spawnError = null
    let settled = false
    const safeCommand = command.map((part) => redactText(part, options.redactions))

    let child
    try {
      child = spawn(command[0], command.slice(1), {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
      })
    } catch (error) {
      resolve({ command: safeCommand, exitCode: null, signal: null, timedOut: false, durationMs: Math.round(performance.now() - started), stdout: "", stderr: "", spawnError: redactText(error?.message ?? error, options.redactions) })
      return
    }

    child.stdout?.on("data", (chunk) => { stdout = appendTail(stdout, chunk.toString()) })
    child.stderr?.on("data", (chunk) => { stderr = appendTail(stderr, chunk.toString()) })
    child.on("error", (error) => { spawnError = redactText(error?.message ?? error, options.redactions) })

    let timeoutFallback = null
    const timer = setTimeout(() => {
      timedOut = true
      terminateProcessTree(child)
      timeoutFallback = setTimeout(() => finish(null, "SIGKILL"), 2_000)
      timeoutFallback.unref?.()
    }, options.timeoutMs)
    timer.unref?.()

    function finish(exitCode, signal) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (timeoutFallback) clearTimeout(timeoutFallback)
      if (!timedOut) terminateProcessTree(child)
      resolve({
        command: safeCommand,
        exitCode,
        signal,
        timedOut,
        durationMs: Math.round(performance.now() - started),
        stdout: redactText(stdout, options.redactions),
        stderr: redactText(stderr, options.redactions),
        spawnError,
      })
    }

    child.on("close", finish)
  })
}
