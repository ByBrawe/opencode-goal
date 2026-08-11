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

async function runInstaller(configDir, args = []) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [installer, ...args], {
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

test("installer help and version do not mutate OpenCode config", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-installer-help-"))
  const configDir = path.join(temp, "missing-config")
  try {
    const help = await runInstaller(configDir, ["--help"])
    assert.equal(help.code, 0, help.stderr)
    assert.match(help.stdout, /OpenCode Goals installer\/updater/)
    assert.equal(await exists(path.join(configDir, "opencode.json")), false)

    const version = await runInstaller(configDir, ["--version"])
    assert.equal(version.code, 0, version.stderr)
    assert.equal(version.stdout.trim(), packageVersion)
    assert.equal(await exists(path.join(configDir, "opencode.json")), false)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test("installer creates global OpenCode config with an exact package pin", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-installer-new-"))
  const configDir = path.join(temp, "config")
  try {
    const result = await runInstaller(configDir)
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, new RegExp(packageSpec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    const config = JSON.parse(await readFile(path.join(configDir, "opencode.json"), "utf8"))
    assert.equal(config.$schema, "https://opencode.ai/config.json")
    assert.deepEqual(config.plugin, [packageSpec])
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test("installer upgrades old package pins, preserves other plugins, and removes duplicate Goal entries", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-installer-update-"))
  const configDir = path.join(temp, "config")
  const pluginDir = path.join(configDir, "plugins")
  try {
    await mkdir(pluginDir, { recursive: true })
    await writeFile(path.join(configDir, "opencode.json"), JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      plugin: [
        "other-plugin@2.0.0",
        "@bybrawe/opencode-goal",
        "@bybrawe/opencode-goal@1.0.0",
        "./plugins/opencode-goal.js",
      ],
    }, null, 2), "utf8")
    await writeFile(path.join(pluginDir, "opencode-goal.js"), "duplicate local plugin", "utf8")

    const result = await runInstaller(configDir)
    assert.equal(result.code, 0, result.stderr)
    const config = JSON.parse(await readFile(path.join(configDir, "opencode.json"), "utf8"))
    assert.deepEqual(config.plugin, ["other-plugin@2.0.0", packageSpec])
    assert.equal(await exists(path.join(pluginDir, "opencode-goal.js")), false)

    const firstBytes = await readFile(path.join(configDir, "opencode.json"), "utf8")
    const second = await runInstaller(configDir)
    assert.equal(second.code, 0, second.stderr)
    assert.match(second.stdout, /Already configured/)
    assert.equal(await readFile(path.join(configDir, "opencode.json"), "utf8"), firstBytes)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test("installer adds Goal to JSONC while preserving comments and trailing-comma compatibility", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-installer-jsonc-"))
  const configDir = path.join(temp, "config")
  try {
    await mkdir(configDir, { recursive: true })
    await writeFile(path.join(configDir, "opencode.jsonc"), `{
  // Keep this comment and the existing plugin.
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "other-plugin",
  ],
  "watcher": {
    "ignore": ["dist/**"],
  },
}
`, "utf8")

    const result = await runInstaller(configDir)
    assert.equal(result.code, 0, result.stderr)
    const updated = await readFile(path.join(configDir, "opencode.jsonc"), "utf8")
    assert.match(updated, /Keep this comment and the existing plugin/)
    assert.match(updated, /"other-plugin"/)
    assert.match(updated, new RegExp(packageSpec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    assert.match(updated, /"watcher"/)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test("installer can add plugin property to an existing JSONC object without discarding comments", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-installer-add-property-"))
  const configDir = path.join(temp, "config")
  try {
    await mkdir(configDir, { recursive: true })
    await writeFile(path.join(configDir, "opencode.jsonc"), `{
  "$schema": "https://opencode.ai/config.json" // schema comment
}
`, "utf8")

    const result = await runInstaller(configDir)
    assert.equal(result.code, 0, result.stderr)
    const updated = await readFile(path.join(configDir, "opencode.jsonc"), "utf8")
    assert.match(updated, /schema comment/)
    assert.match(updated, new RegExp(packageSpec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test("installer fails closed when plugin config is not an array", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-installer-invalid-"))
  const configDir = path.join(temp, "config")
  const configPath = path.join(configDir, "opencode.json")
  try {
    await mkdir(configDir, { recursive: true })
    const original = JSON.stringify({ plugin: "other-plugin" }, null, 2)
    await writeFile(configPath, original, "utf8")
    const result = await runInstaller(configDir)
    assert.notEqual(result.code, 0)
    assert.equal(await readFile(configPath, "utf8"), original)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
