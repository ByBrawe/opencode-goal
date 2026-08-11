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
const managedCommandMarker = "<!-- managed-by:@bybrawe/opencode-goal -->"

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

async function assertManagedGoalCommand(configDir) {
  const command = await readFile(path.join(configDir, "commands", "goal.md"), "utf8")
  assert.match(command, /description: Set or manage a persistent evidence-verified goal/)
  assert.match(command, new RegExp(managedCommandMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  assert.match(command, /\$ARGUMENTS/)
}

test("installer help and version do not mutate OpenCode config", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-installer-help-"))
  const configDir = path.join(temp, "missing-config")
  try {
    const help = await runInstaller(configDir, ["--help"])
    assert.equal(help.code, 0, help.stderr)
    assert.match(help.stdout, /OpenCode Goals installer\/updater/)
    assert.match(help.stdout, /--uninstall/)
    assert.match(help.stdout, /commands\/goal\.md/)
    assert.equal(await exists(path.join(configDir, "opencode.json")), false)

    const version = await runInstaller(configDir, ["--version"])
    assert.equal(version.code, 0, version.stderr)
    assert.equal(version.stdout.trim(), packageVersion)
    assert.equal(await exists(path.join(configDir, "opencode.json")), false)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test("installer creates global OpenCode config, exact package pin, and discoverable /goal command", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-installer-new-"))
  const configDir = path.join(temp, "config")
  try {
    const result = await runInstaller(configDir)
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, new RegExp(packageSpec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    assert.match(result.stdout, /Installed managed \/goal command/)
    const config = JSON.parse(await readFile(path.join(configDir, "opencode.json"), "utf8"))
    assert.equal(config.$schema, "https://opencode.ai/config.json")
    assert.deepEqual(config.plugin, [packageSpec])
    await assertManagedGoalCommand(configDir)
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
    await assertManagedGoalCommand(configDir)

    const firstConfig = await readFile(path.join(configDir, "opencode.json"), "utf8")
    const firstCommand = await readFile(path.join(configDir, "commands", "goal.md"), "utf8")
    const second = await runInstaller(configDir)
    assert.equal(second.code, 0, second.stderr)
    assert.match(second.stdout, /Already configured/)
    assert.equal(await readFile(path.join(configDir, "opencode.json"), "utf8"), firstConfig)
    assert.equal(await readFile(path.join(configDir, "commands", "goal.md"), "utf8"), firstCommand)
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
    await assertManagedGoalCommand(configDir)
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
    await assertManagedGoalCommand(configDir)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test("installer refuses to overwrite a user-owned global goal command before mutating config", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-installer-command-conflict-"))
  const configDir = path.join(temp, "config")
  const commandPath = path.join(configDir, "commands", "goal.md")
  try {
    await mkdir(path.dirname(commandPath), { recursive: true })
    await writeFile(commandPath, "---\ndescription: my command\n---\ncustom\n", "utf8")
    const result = await runInstaller(configDir)
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /Refusing to overwrite user-owned OpenCode command/)
    assert.equal(await exists(path.join(configDir, "opencode.json")), false)
    assert.equal(await readFile(commandPath, "utf8"), "---\ndescription: my command\n---\ncustom\n")
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test("uninstall removes Goal registrations, managed command, and local copies while preserving other plugins and project state", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-installer-uninstall-"))
  const configDir = path.join(temp, "config")
  const pluginDir = path.join(configDir, "plugins")
  const projectState = path.join(temp, "project", ".opencode", "goals", "saved.json")
  try {
    await mkdir(pluginDir, { recursive: true })
    await mkdir(path.dirname(projectState), { recursive: true })
    await writeFile(projectState, "preserve me", "utf8")
    await writeFile(path.join(pluginDir, "opencode-goal.ts"), "legacy local plugin", "utf8")
    await writeFile(path.join(configDir, "opencode.jsonc"), `{
  // Preserve this OpenCode config comment.
  "plugin": [
    "other-plugin@2.0.0",
    "@bybrawe/opencode-goal@1.0.0",
    "./plugins/opencode-goal.ts",
  ],
  "permission": { "read": "allow" },
}
`, "utf8")

    const install = await runInstaller(configDir)
    assert.equal(install.code, 0, install.stderr)
    await assertManagedGoalCommand(configDir)

    const result = await runInstaller(configDir, ["--uninstall"])
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /Removed OpenCode Goals registrations/)
    assert.match(result.stdout, /Removed managed \/goal command/)
    assert.match(result.stdout, /Project Goal state .* is preserved/)
    const updated = await readFile(path.join(configDir, "opencode.jsonc"), "utf8")
    assert.match(updated, /Preserve this OpenCode config comment/)
    assert.match(updated, /"other-plugin@2\.0\.0"/)
    assert.match(updated, /"permission"/)
    assert.doesNotMatch(updated, /@bybrawe\/opencode-goal/)
    assert.doesNotMatch(updated, /plugins\/opencode-goal/)
    assert.equal(await exists(path.join(pluginDir, "opencode-goal.ts")), false)
    assert.equal(await exists(path.join(configDir, "commands", "goal.md")), false)
    assert.equal(await readFile(projectState, "utf8"), "preserve me")

    const second = await runInstaller(configDir, ["--uninstall"])
    assert.equal(second.code, 0, second.stderr)
    assert.match(second.stdout, /was not registered/)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test("uninstall preserves a user-owned goal command", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-uninstall-user-command-"))
  const configDir = path.join(temp, "config")
  const commandPath = path.join(configDir, "commands", "goal.md")
  try {
    await mkdir(path.dirname(commandPath), { recursive: true })
    await writeFile(path.join(configDir, "opencode.json"), JSON.stringify({ plugin: [packageSpec] }), "utf8")
    const custom = "---\ndescription: user-owned goal command\n---\ncustom\n"
    await writeFile(commandPath, custom, "utf8")
    const result = await runInstaller(configDir, ["--uninstall"])
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stderr, /Preserved user-owned OpenCode command/)
    assert.equal(await readFile(commandPath, "utf8"), custom)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test("installer and uninstall fail closed when plugin config is not an array", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-installer-invalid-"))
  const configDir = path.join(temp, "config")
  const configPath = path.join(configDir, "opencode.json")
  const pluginPath = path.join(configDir, "plugins", "opencode-goal.ts")
  try {
    await mkdir(path.dirname(pluginPath), { recursive: true })
    const original = JSON.stringify({ plugin: "other-plugin" }, null, 2)
    await writeFile(configPath, original, "utf8")
    await writeFile(pluginPath, "must survive failed uninstall", "utf8")

    const installResult = await runInstaller(configDir)
    assert.notEqual(installResult.code, 0)
    assert.equal(await readFile(configPath, "utf8"), original)

    const uninstallResult = await runInstaller(configDir, ["--uninstall"])
    assert.notEqual(uninstallResult.code, 0)
    assert.equal(await readFile(configPath, "utf8"), original)
    assert.equal(await readFile(pluginPath, "utf8"), "must survive failed uninstall")
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
