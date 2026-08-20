import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"

const expected = "1.3.24"
const packageSpec = `@bybrawe/opencode-goal@${expected}`

function runNpm(args, cwd) {
  const npmExecPath = process.env.npm_execpath
  const command = npmExecPath ? process.execPath : (process.platform === "win32" ? "npm.cmd" : "npm")
  const commandArgs = npmExecPath ? [npmExecPath, ...args] : args
  return spawnSync(command, commandArgs, {
    cwd,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
  })
}

test("public npm 1.3.24 is latest and its installer runs from a clean consumer", { skip: process.platform !== "linux" }, () => {
  const view = runNpm(["view", packageSpec, "version", "--registry=https://registry.npmjs.org"], process.cwd())
  assert.equal(view.status, 0, view.stderr || view.error?.message)
  assert.equal(view.stdout.trim(), expected)

  const latest = runNpm(["view", "@bybrawe/opencode-goal@latest", "version", "--registry=https://registry.npmjs.org"], process.cwd())
  assert.equal(latest.status, 0, latest.stderr || latest.error?.message)
  assert.equal(latest.stdout.trim(), expected)

  const root = mkdtempSync(path.join(os.tmpdir(), "opencode-goal-public-canary-"))
  try {
    const installed = runNpm(["exec", "--yes", `--package=${packageSpec}`, "--", "opencode-goal", "--version"], root)
    assert.equal(installed.status, 0, installed.stderr || installed.error?.message)
    assert.equal(installed.stdout.trim(), expected)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
