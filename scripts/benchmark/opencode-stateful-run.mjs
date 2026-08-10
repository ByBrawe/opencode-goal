import { spawn } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"

function usage() {
  return "Usage: node scripts/benchmark/opencode-stateful-run.mjs <command-name> <raw-arguments>"
}

async function markerPath() {
  const home = process.env.HOME || process.env.USERPROFILE
  if (!home) throw new Error("stateful OpenCode benchmark requires HOME/USERPROFILE")
  const root = path.join(home, ".cache", "opencode-goal-benchmark")
  await mkdir(root, { recursive: true })
  return path.join(root, "opencode-run-started")
}

async function markerExists(file) {
  try {
    await readFile(file, "utf8")
    return true
  } catch (error) {
    if (error?.code === "ENOENT") return false
    throw error
  }
}

function runChild(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    })
    child.once("error", reject)
    child.once("close", (code, signal) => resolve({ code, signal }))
  })
}

async function main(argv = process.argv.slice(2)) {
  const [commandName, rawArguments, ...extra] = argv
  if (!commandName || rawArguments === undefined || extra.length) throw new Error(usage())

  const marker = await markerPath()
  const continuing = await markerExists(marker)
  const executable = process.env.OPENCODE_BIN || (process.platform === "win32" ? "opencode.cmd" : "opencode")
  const args = ["run", ...(continuing ? ["--continue"] : []), "--command", commandName, rawArguments]
  const result = await runChild(executable, args)

  // Once OpenCode was launched successfully enough to produce a process-close
  // event, later benchmark steps must target the same latest session. If the
  // first command itself fails, continuing that exact session is more honest
  // than silently creating a fresh one for the next step.
  if (!continuing) await writeFile(marker, `${Date.now()}\n`, { encoding: "utf8", flag: "wx" }).catch((error) => {
    if (error?.code !== "EEXIST") throw error
  })

  if (result.signal) {
    process.kill(process.pid, result.signal)
    return
  }
  process.exitCode = result.code ?? 1
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
