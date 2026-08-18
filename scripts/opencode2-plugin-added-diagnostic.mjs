import { spawn } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

async function run(command, args, { cwd, env, allowFailure = false, timeout = 60_000 } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => { child.kill(); reject(new Error(`timeout: ${command} ${args.join(" ")}\n${stdout}\n${stderr}`)) }, timeout)
    child.stdout?.on("data", (chunk) => { stdout = (stdout + String(chunk)).slice(-100_000) })
    child.stderr?.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-100_000) })
    child.once("error", (error) => { clearTimeout(timer); reject(error) })
    child.once("close", (status) => {
      clearTimeout(timer)
      if (!allowFailure && status !== 0) return reject(new Error(`failed (${status}): ${command} ${args.join(" ")}\n${stdout}\n${stderr}`))
      resolve({ status, stdout, stderr })
    })
  })
}

async function sleep(ms) { await new Promise((resolve) => setTimeout(resolve, ms)) }

async function main() {
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-v2-plugin-events-"))
  const project = path.join(temp, "project")
  const home = path.join(temp, "home")
  const config = path.join(home, ".config")
  const data = path.join(home, ".local", "share")
  const state = path.join(home, ".local", "state")
  const pluginDir = path.join(project, ".opencode", "plugins")
  const traceFile = path.join(temp, "plugin-added.jsonl")
  const targetHref = pathToFileURL(path.join(root, "dist", "opencode2", "experimental.js")).href

  await Promise.all([mkdir(pluginDir, { recursive: true }), mkdir(config, { recursive: true }), mkdir(data, { recursive: true }), mkdir(state, { recursive: true })])
  await writeFile(path.join(pluginDir, "opencode-goals-v2-plugin-events.js"), [
    'import { appendFileSync } from "node:fs"',
    `import target from ${JSON.stringify(targetHref)}`,
    `const traceFile = ${JSON.stringify(traceFile)}`,
    'export default {',
    '  id: target.id,',
    '  async setup(ctx) {',
    '    if (typeof ctx.event?.subscribe === "function") {',
    '      const stream = ctx.event.subscribe()',
    '      void (async () => {',
    '        try {',
    '          for await (const event of stream) {',
    '            if (event?.type === "plugin.added") appendFileSync(traceFile, `${JSON.stringify({ at: Date.now(), type: event.type, id: event?.data?.id, data: event?.data })}\\n`, "utf8")',
    '          }',
    '        } catch (error) { appendFileSync(traceFile, `${JSON.stringify({ type: "error", error: String(error) })}\\n`, "utf8") }',
    '      })()',
    '    }',
    '    return await target.setup(ctx)',
    '  },',
    '}',
    '',
  ].join("\n"))
  await writeFile(path.join(project, "README.md"), "# plugin event diagnostic\n")
  await writeFile(path.join(project, "opencode.json"), `${JSON.stringify({ $schema: "https://opencode.ai/config.json", command: { goal: { template: "GOAL $ARGUMENTS", description: "goal" } } }, null, 2)}\n`)

  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data, XDG_STATE_HOME: state, OPENCODE_DB: path.join(data, "opencode", "events.db"), OPENCODE_LOG_LEVEL: "DEBUG", CI: "true" }
  await run("git", ["init", "-q"], { cwd: project, env })
  await run("git", ["config", "user.name", "V2 Events"], { cwd: project, env })
  await run("git", ["config", "user.email", "events@example.invalid"], { cwd: project, env })
  await run("git", ["add", "."], { cwd: project, env })
  await run("git", ["commit", "-q", "-m", "init"], { cwd: project, env })

  try {
    await run("opencode2", ["service", "stop"], { cwd: project, env, allowFailure: true, timeout: 20_000 })
    const query = `location%5Bdirectory%5D=${encodeURIComponent(project)}`
    await run("opencode2", ["api", "get", `/api/health?${query}`], { cwd: project, env })
    await run("opencode2", ["api", "get", `/api/plugin?${query}`], { cwd: project, env })
    await run("opencode2", ["api", "get", `/api/command?${query}`], { cwd: project, env })
    await sleep(2000)
    const trace = await readFile(traceFile, "utf8").catch(() => "")
    console.log(JSON.stringify({ trace, ids: trace.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line).id) }, null, 2))
    throw new Error("diagnostic-only: enumerate plugin.added IDs")
  } finally {
    await run("opencode2", ["service", "stop"], { cwd: project, env, allowFailure: true, timeout: 20_000 }).catch(() => undefined)
    await rm(temp, { recursive: true, force: true }).catch(() => undefined)
  }
}

main().catch((error) => { console.error(error?.stack || error); process.exitCode = 1 })
