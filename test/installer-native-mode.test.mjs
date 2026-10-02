import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const version = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version
const spec = `@bybrawe/opencode-goal@${version}`
const exists = (file) => access(file).then(() => true, () => false)
async function fixture(fn) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "goal-native-install-"))
  try { await fn(path.join(temp, "config")) } finally { await rm(temp, { recursive: true, force: true }) }
}
function run(config, args = [], env = {}) {
  return spawnSync(process.execPath, [path.join(root, "dist/install.js"), ...args], {
    cwd: root, encoding: "utf8", timeout: 20_000,
    env: { ...process.env, OPENCODE_CONFIG_DIR: config, OPENCODE_GOAL_HOST_VERSION: "", OPENCODE_BINARY: "missing-opencode-for-install-test", ...env },
  })
}

test("clean install defaults to native V2 even without a host binary", () => fixture(async (config) => {
  const result = run(config)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(await readFile(path.join(config, "opencode.json"), "utf8")).plugins, [spec])
  assert.equal(await exists(path.join(config, "commands/goal.md")), false)
}))

test("explicit native and legacy install modes override the environment target", () => fixture(async (config) => {
  let result = run(config, ["--legacy-v1"], { OPENCODE_GOAL_HOST_VERSION: "2.0.18" })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(await readFile(path.join(config, "opencode.json"), "utf8")).plugin, [spec])
  assert.equal(await exists(path.join(config, "commands/goal.md")), true)
  result = run(config, ["--native-v2"], { OPENCODE_GOAL_HOST_VERSION: "1.18.15" })
  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(await readFile(path.join(config, "opencode.json"), "utf8"))
  assert.deepEqual(parsed.plugins, [spec])
  assert.equal("plugin" in parsed, false)
  assert.equal(await exists(path.join(config, "commands/goal.md")), false)
}))

test("invalid target and conflicting mode flags fail before config mutation; help stays offline", () => fixture(async (config) => {
  for (const envVersion of ["bogus 2.0.18 output", "3.0.0"]) {
    const result = run(config, [], { OPENCODE_GOAL_HOST_VERSION: envVersion })
    assert.notEqual(result.status, 0)
    assert.equal(await exists(config), false)
  }
  const conflict = run(config, ["--native-v2", "--legacy-v1"])
  assert.notEqual(conflict.status, 0)
  assert.equal(await exists(config), false)
  for (const flag of ["--help", "--version", "--uninstall"]) {
    const result = run(config, [flag], { OPENCODE_GOAL_HOST_VERSION: "invalid" })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(await exists(config), false)
  }
}))

test("native update preserves object options, JSONC comments and custom goal command", () => fixture(async (config) => {
  await mkdir(path.join(config, "commands"), { recursive: true })
  const own = { package: "@bybrawe/opencode-goal@1.0.0", options: { autonomous: false, note: "literal } // value", nested: { count: 2 } }, enabled: false }
  const source = `{
  // retain root comment
  "plugin": [${JSON.stringify(own)}, "other-v1"],
  "plugins": ["other-v2", "@bybrawe/opencode-goal@1.2.0"],
  "model": "test/test",
}\n`
  await writeFile(path.join(config, "opencode.jsonc"), source)
  await writeFile(path.join(config, "commands/goal.md"), "custom goal command\n")
  const result = run(config, [], { OPENCODE_GOAL_HOST_VERSION: "2.0.18" })
  assert.equal(result.status, 0, result.stderr)
  const updated = await readFile(path.join(config, "opencode.jsonc"), "utf8")
  assert.match(updated, /retain root comment/)
  const parsed = JSON.parse(updated.replace(/\/\/.*$/gm, "").replace(/,\s*([}\]])/g, "$1"))
  assert.equal("plugin" in parsed, false)
  assert.deepEqual(parsed.plugins, ["other-v1", "other-v2", { ...own, package: spec }])
  assert.equal(await readFile(path.join(config, "commands/goal.md"), "utf8"), "custom goal command\n")
  assert.equal(run(config, [], { OPENCODE_GOAL_HOST_VERSION: "2.0.18" }).status, 0)
  assert.equal(await readFile(path.join(config, "opencode.jsonc"), "utf8"), updated)
}))

test("conflicting object registrations in a later config cannot partially migrate earlier files", () => fixture(async (config) => {
  await mkdir(config, { recursive: true })
  const first = JSON.stringify({ plugin: ["@bybrawe/opencode-goal@1.0.0"] })
  const second = JSON.stringify({ plugins: [
    { package: "@bybrawe/opencode-goal@1.0.0", options: { autonomous: true } },
    { package: "@bybrawe/opencode-goal@1.2.0", options: { autonomous: false } },
  ] })
  await writeFile(path.join(config, "opencode.json"), first)
  await writeFile(path.join(config, "opencode.jsonc"), second)
  const result = run(config, [], { OPENCODE_GOAL_HOST_VERSION: "2.0.18" })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Conflicting Goal object registrations/)
  assert.equal(await readFile(path.join(config, "opencode.json"), "utf8"), first)
  assert.equal(await readFile(path.join(config, "opencode.jsonc"), "utf8"), second)
  assert.equal(run(config, ["--uninstall"]).status, 0, "explicit uninstall must still be able to remove conflicting entries")
}))

test("official V1 tuple migrates to native options and stays a tuple on explicit V1", () => fixture(async (config) => {
  await mkdir(config, { recursive: true })
  const options = { autonomous: false, note: "literal // value", nested: { enabled: true } }
  const tuple = ["@bybrawe/opencode-goal@1.0.0", options]
  const other = ["other-plugin", { keep: true }]
  const file = path.join(config, "opencode.json")
  await writeFile(file, JSON.stringify({ plugin: [tuple, other] }))
  let result = run(config, ["--legacy-v1"])
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")).plugin, [other, [spec, options]])
  result = run(config, ["--native-v2"])
  assert.equal(result.status, 0, result.stderr)
  const migrated = JSON.parse(await readFile(file, "utf8"))
  assert.equal("plugin" in migrated, false)
  assert.deepEqual(migrated.plugins, [{ package: "other-plugin", options: { keep: true } }, { package: spec, options }])
  const before = await readFile(file, "utf8")
  assert.equal(run(config).status, 0)
  assert.equal(await readFile(file, "utf8"), before)
}))

test("native install collapses valid legacy plugin list into one canonical plugins property", () => fixture(async (config) => {
  await mkdir(config, { recursive: true })
  const file = path.join(config, "opencode.json")
  const provider = { google: { models: { demo: { name: "Demo" } } } }
  await writeFile(file, JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    plugin: [
      "opencode-antigravity-auth@beta",
      "@tarquinen/opencode-dcp@latest",
      "opencode-power-pack@git+https://github.com/waybarrios/opencode-power-pack.git",
    ],
    provider,
    model: "",
  }, null, 2))
  const result = run(config, ["--native-v2"])
  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(await readFile(file, "utf8"))
  assert.equal("plugin" in parsed, false)
  assert.deepEqual(parsed.plugins, [
    "opencode-antigravity-auth@beta",
    "@tarquinen/opencode-dcp@latest",
    "opencode-power-pack@git+https://github.com/waybarrios/opencode-power-pack.git",
    spec,
  ])
  assert.deepEqual(parsed.provider, provider, "Goal installer must not rewrite unrelated provider configuration")
  assert.equal(parsed.model, "", "Goal installer must not rewrite unrelated model configuration")
}))

test("malformed tuples and mixed tuple/object conflicts fail before rewriting; uninstall removes them", () => fixture(async (config) => {
  await mkdir(config, { recursive: true })
  const file = path.join(config, "opencode.json")
  for (const entries of [
    [["@bybrawe/opencode-goal@1.0.0", false]],
    [["@bybrawe/opencode-goal@1.0.0", {}, "extra"]],
    [["@bybrawe/opencode-goal@1.0.0", { autonomous: false }], { package: spec, options: { autonomous: true } }],
  ]) {
    const before = JSON.stringify({ plugin: entries })
    await writeFile(file, before)
    const result = run(config)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Invalid Goal package\/options tuple|Conflicting Goal object registrations/)
    assert.equal(await readFile(file, "utf8"), before)
    assert.equal(run(config, ["--uninstall"]).status, 0)
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")).plugin, [])
  }
}))
