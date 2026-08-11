import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { materializeSemanticAction, parseCanonicalAction, validateActionAdapter } from "../scripts/benchmark/semantic-action-adapter.mjs"
import { validateManifest } from "../scripts/competitive-benchmark.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const adapterPath = path.join(root, "benchmarks", "adapters", "opencode-goals.json")
const sequenceAdapterPath = path.join(root, "benchmarks", "adapters", "opencode-goals-sequence.json")
const willySequenceAdapterPath = path.join(root, "benchmarks", "adapters", "willytop8-sequence.json")
const prevalentSequenceAdapterPath = path.join(root, "benchmarks", "adapters", "prevalentware-sequence.json")
const cli = path.join(root, "scripts", "benchmark", "semantic-action-adapter-cli.mjs")

async function adapterAt(file, label = path.basename(file)) {
  return validateActionAdapter(JSON.parse(await readFile(file, "utf8")), label)
}

async function adapter() {
  return adapterAt(adapterPath, "opencode-goals adapter")
}

test("semantic action adapter translates only syntax and preserves canonical objective bytes", async () => {
  const mapping = await adapter()
  assert.deepEqual(materializeSemanticAction(mapping, '{"action":"enqueue","objective":"write first exactly"}'), {
    commandName: "goal",
    rawArguments: "add write first exactly",
  })
  assert.deepEqual(materializeSemanticAction(mapping, '{"action":"advance"}'), {
    commandName: "goal",
    rawArguments: "next",
  })

  const hostileLooking = 'quotes \" ; $HOME && rm -rf / are task text, not shell syntax'
  const canonical = JSON.stringify({ action: "enqueue", objective: hostileLooking })
  assert.equal(materializeSemanticAction(mapping, canonical).rawArguments, `add ${hostileLooking}`)

  assert.throws(() => materializeSemanticAction(mapping, '{"action":"missing"}'), /does not support canonical action missing/)
  assert.throws(() => materializeSemanticAction(mapping, '{"action":"enqueue"}'), /missing template field objective/)
  assert.throws(() => parseCanonicalAction('{"action":"enqueue","objective":{"nested":true}}'), /must be a string, number, or boolean/)
  assert.throws(() => parseCanonicalAction("not-json"), /must be valid JSON/)
})

test("semantic action adapter supports compound sequence syntax and explicit capability gaps", async () => {
  const canonical = JSON.stringify({ action: "start_sequence", first: "first objective", second: "second objective" })
  const ours = await adapterAt(sequenceAdapterPath)
  const willy = await adapterAt(willySequenceAdapterPath)
  const prevalent = await adapterAt(prevalentSequenceAdapterPath)

  assert.deepEqual(materializeSemanticAction(ours, canonical), {
    commandName: "goal",
    rawArguments: ["add first objective", "add second objective", "next"],
  })
  assert.deepEqual(materializeSemanticAction(willy, canonical), {
    commandName: "goal",
    rawArguments: "sequence first objective; second objective",
  })
  assert.throws(
    () => materializeSemanticAction(prevalent, canonical),
    /BENCHMARK_CAPABILITY_UNSUPPORTED: canonical action start_sequence/i,
  )

  assert.throws(
    () => validateActionAdapter({ schemaVersion: 1, commandName: "goal", actions: { x: [] } }),
    /must not be an empty command sequence/,
  )
  assert.throws(
    () => validateActionAdapter({ schemaVersion: 1, commandName: "goal", actions: { x: { unsupported: "" } } }),
    /must be a non-empty string/,
  )
})

test("semantic action adapter CLI keeps mapped actions in one isolated OpenCode session", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-action-adapter-"))
  const workspace = path.join(temp, "workspace")
  const home = path.join(temp, "home")
  const log = path.join(temp, "calls.log")
  try {
    await mkdir(workspace, { recursive: true })
    await mkdir(home, { recursive: true })
    await writeFile(path.join(workspace, "run"), `const fs = require("node:fs"); fs.appendFileSync(process.env.DRIVER_LOG, JSON.stringify(process.argv.slice(2)) + "\\n")\n`, "utf8")
    const env = { ...process.env, HOME: home, USERPROFILE: home, OPENCODE_BIN: process.execPath, DRIVER_LOG: log }

    const first = spawnSync(process.execPath, [cli, adapterPath, JSON.stringify({ action: "enqueue", objective: "first objective" })], {
      cwd: workspace,
      encoding: "utf8",
      env,
    })
    assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`)

    const second = spawnSync(process.execPath, [cli, adapterPath, JSON.stringify({ action: "advance" })], {
      cwd: workspace,
      encoding: "utf8",
      env,
    })
    assert.equal(second.status, 0, `${second.stderr}\n${second.stdout}`)

    const calls = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    assert.deepEqual(calls, [
      ["--command", "goal", "add first objective"],
      ["--continue", "--command", "goal", "next"],
    ])
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test("compound semantic action executes every mapped command in the same session", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-action-compound-"))
  const workspace = path.join(temp, "workspace")
  const home = path.join(temp, "home")
  const log = path.join(temp, "calls.log")
  try {
    await mkdir(workspace, { recursive: true })
    await mkdir(home, { recursive: true })
    await writeFile(path.join(workspace, "run"), `const fs = require("node:fs"); fs.appendFileSync(process.env.DRIVER_LOG, JSON.stringify(process.argv.slice(2)) + "\\n")\n`, "utf8")
    const env = { ...process.env, HOME: home, USERPROFILE: home, OPENCODE_BIN: process.execPath, DRIVER_LOG: log }
    const canonical = JSON.stringify({ action: "start_sequence", first: "first objective", second: "second objective" })

    const result = spawnSync(process.execPath, [cli, sequenceAdapterPath, canonical], {
      cwd: workspace,
      encoding: "utf8",
      env,
    })
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`)

    const calls = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    assert.deepEqual(calls, [
      ["--command", "goal", "add first objective"],
      ["--continue", "--command", "goal", "add second objective"],
      ["--continue", "--command", "goal", "next"],
    ])
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test("compound semantic action fails closed and never executes commands after a failed subcommand", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-action-fail-"))
  const workspace = path.join(temp, "workspace")
  const home = path.join(temp, "home")
  const log = path.join(temp, "calls.log")
  try {
    await mkdir(workspace, { recursive: true })
    await mkdir(home, { recursive: true })
    await writeFile(
      path.join(workspace, "run"),
      `const fs = require("node:fs"); const p = process.env.DRIVER_LOG; let before = ""; try { before = fs.readFileSync(p, "utf8") } catch {} const count = before.trim() ? before.trim().split("\\n").length : 0; fs.appendFileSync(p, JSON.stringify(process.argv.slice(2)) + "\\n"); if (count === 1) process.exit(7)\n`,
      "utf8",
    )
    const env = { ...process.env, HOME: home, USERPROFILE: home, OPENCODE_BIN: process.execPath, DRIVER_LOG: log }
    const canonical = JSON.stringify({ action: "start_sequence", first: "first objective", second: "second objective" })

    const result = spawnSync(process.execPath, [cli, sequenceAdapterPath, canonical], {
      cwd: workspace,
      encoding: "utf8",
      env,
    })
    assert.equal(result.status, 7, `${result.stderr}\n${result.stdout}`)

    const calls = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    assert.deepEqual(calls, [
      ["--command", "goal", "add first objective"],
      ["--continue", "--command", "goal", "add second objective"],
    ])
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test("canonical ordered-sequence pilot is valid and uses only semantic action JSON prompts", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "benchmarks", "ordered-sequence.semantic.pilot.json"), "utf8"))
  assert.equal(validateManifest(manifest), manifest)
  const steps = manifest.scenarios[0].steps
  assert.deepEqual(steps.map((step) => JSON.parse(step.prompt).action), ["enqueue", "enqueue", "advance"])
  assert.ok(steps.slice(0, 2).every((step) => typeof JSON.parse(step.prompt).objective === "string"))
  assert.equal(JSON.parse(steps[2].prompt).objective, undefined)
})

test("cross-plugin ordered-sequence example pins identical semantics and exact plugin versions", async () => {
  const manifestPath = path.join(root, "benchmarks", "ordered-sequence.cross-plugin.example.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  assert.equal(validateManifest(manifest), manifest)
  assert.equal(manifest.metadata.opencodeVersion, "1.17.15")
  assert.equal(manifest.repeats, 5)
  assert.equal(manifest.scenarios.length, 1)
  assert.equal(manifest.scenarios[0].steps.length, 1)

  const action = JSON.parse(manifest.scenarios[0].steps[0].prompt)
  assert.deepEqual(action, {
    action: "start_sequence",
    first: "create order.log containing exactly one line first and nothing else",
    second: "append exactly one new line second after first in order.log without changing the first line or adding other content",
  })

  const pluginSpecs = manifest.competitors.flatMap((competitor) => competitor.opencodeConfig.plugin ?? [])
  assert.deepEqual(pluginSpecs, [
    "@bybrawe/opencode-goal@1.3.0",
    "opencode-goal-plugin@0.6.5",
    "@prevalentware/opencode-goal-plugin@0.4.10",
  ])
  assert.ok(manifest.competitors.every((competitor) => competitor.command.at(-1) === "{prompt}"))
})
