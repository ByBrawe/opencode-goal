import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const installer = path.join(root, "dist", "install.js")
const packageVersion = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version
const packageSpec = `@bybrawe/opencode-goal@${packageVersion}`

async function runInstaller(configDir) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [installer], {
      cwd: root,
      env: { ...process.env, OPENCODE_CONFIG_DIR: configDir },
      windowsHide: true,
    })
    const stdout = []
    const stderr = []
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)))
    child.on("error", reject)
    child.on("close", (code) => resolve({
      code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }))
  })
}

async function exists(target) {
  try {
    await readFile(target)
    return true
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EISDIR") return false
    throw error
  }
}

test("installer normalizes Goal registration across every existing global config file", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-multi-config-"))
  const configDir = path.join(temp, "config")
  try {
    await mkdir(configDir, { recursive: true })
    await writeFile(path.join(configDir, "opencode.json"), `${JSON.stringify({
      plugin: ["other-plugin", "@bybrawe/opencode-goal@1.0.0"],
      model: "test/model",
    }, null, 2)}\n`)
    await writeFile(path.join(configDir, "opencode.jsonc"), `{
  // This later config must not shadow the Goal package pin.
  "permission": { "read": "allow" },
}
`)

    const result = await runInstaller(configDir)
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /across 2 OpenCode config files/)

    const json = JSON.parse(await readFile(path.join(configDir, "opencode.json"), "utf8"))
    assert.deepEqual(json.plugin, ["other-plugin", packageSpec])

    const jsonc = await readFile(path.join(configDir, "opencode.jsonc"), "utf8")
    assert.match(jsonc, /later config must not shadow/)
    assert.match(jsonc, new RegExp(packageSpec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    assert.match(jsonc, /"permission"/)

    const command = await readFile(path.join(configDir, "commands", "goal.md"), "utf8")
    assert.match(command, /managed-by:@bybrawe\/opencode-goal/)

    const beforeJson = await readFile(path.join(configDir, "opencode.json"), "utf8")
    const beforeJsonc = await readFile(path.join(configDir, "opencode.jsonc"), "utf8")
    const second = await runInstaller(configDir)
    assert.equal(second.code, 0, second.stderr)
    assert.equal(await readFile(path.join(configDir, "opencode.json"), "utf8"), beforeJson)
    assert.equal(await readFile(path.join(configDir, "opencode.jsonc"), "utf8"), beforeJsonc)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test("multi-config install stages every rewrite before mutating real config", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-multi-config-fail-"))
  const configDir = path.join(temp, "config")
  try {
    await mkdir(configDir, { recursive: true })
    const first = `${JSON.stringify({ plugin: ["other-plugin"] }, null, 2)}\n`
    const invalid = `${JSON.stringify({ plugin: "not-an-array" }, null, 2)}\n`
    await writeFile(path.join(configDir, "opencode.json"), first)
    await writeFile(path.join(configDir, "opencode.jsonc"), invalid)

    const result = await runInstaller(configDir)
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /No config files were changed/)
    assert.equal(await readFile(path.join(configDir, "opencode.json"), "utf8"), first)
    assert.equal(await readFile(path.join(configDir, "opencode.jsonc"), "utf8"), invalid)
    assert.equal(await exists(path.join(configDir, "commands", "goal.md")), false)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
