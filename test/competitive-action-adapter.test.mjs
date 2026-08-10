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
const cli = path.join(root, "scripts", "benchmark", "semantic-action-adapter-cli.mjs")

async function adapter() {
  return validateActionAdapter(JSON.parse(await readFile(adapterPath, "utf8")), "opencode-goals adapter")
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

test("canonical ordered-sequence pilot is valid and uses only semantic action JSON prompts", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "benchmarks", "ordered-sequence.semantic.pilot.json"), "utf8"))
  assert.equal(validateManifest(manifest), manifest)
  const steps = manifest.scenarios[0].steps
  assert.deepEqual(steps.map((step) => JSON.parse(step.prompt).action), ["enqueue", "enqueue", "advance"])
  assert.ok(steps.slice(0, 2).every((step) => typeof JSON.parse(step.prompt).objective === "string"))
  assert.equal(JSON.parse(steps[2].prompt).objective, undefined)
})
