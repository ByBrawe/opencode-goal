import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import process from "node:process"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const driver = path.join(root, "scripts", "benchmark", "opencode-stateful-run.mjs")

function invoke(cwd, home, log, prompt) {
  const result = spawnSync(process.execPath, [driver, "goal", prompt], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home, OPENCODE_BIN: process.execPath, DRIVER_LOG: log },
  })
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`)
}

test("OpenCode stateful benchmark driver continues the same isolated session after its first step", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-stateful-driver-"))
  const workspace = path.join(temp, "workspace")
  const home = path.join(temp, "home")
  const otherHome = path.join(temp, "other-home")
  const log = path.join(temp, "calls.log")
  try {
    await mkdir(workspace, { recursive: true })
    await mkdir(home, { recursive: true })
    await mkdir(otherHome, { recursive: true })
    await writeFile(path.join(workspace, "run"), `const fs = require("node:fs"); fs.appendFileSync(process.env.DRIVER_LOG, JSON.stringify(process.argv.slice(2)) + "\\n")\n`, "utf8")

    invoke(workspace, home, log, "first goal")
    invoke(workspace, home, log, "queue second goal")
    invoke(workspace, otherHome, log, "fresh isolated run")

    const calls = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    assert.deepEqual(calls, [
      ["--command", "goal", "first goal"],
      ["--continue", "--command", "goal", "queue second goal"],
      ["--command", "goal", "fresh isolated run"],
    ])
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
