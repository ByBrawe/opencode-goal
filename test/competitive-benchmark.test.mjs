import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { digestFixtureTree, expandRuns, materializeCommand, redactText, renderMarkdown, runCommand, summarize, validateManifest } from "../scripts/competitive-benchmark.mjs"

const manifest = {
  schemaVersion: 1,
  repeats: 2,
  competitors: [
    { id: "a", command: ["tool", "{prompt}"], setup: { command: ["node", "setup.mjs", "{home}"] }, opencodeConfig: { plugin: ["pkg@1.2.3"] } },
    { id: "b", command: ["tool", "{prompt}"] },
  ],
  scenarios: [{ id: "s", category: "safety", weight: 5, workspace: "fixture", prompt: "do it", oracle: { command: ["node", "oracle.mjs"] } }],
}

test("competitive benchmark manifest expands deterministic competitor/scenario repeats", () => {
  validateManifest(manifest)
  assert.deepEqual(expandRuns(manifest).map((item) => [item.competitor.id, item.scenario.id, item.repeat]), [
    ["a", "s", 1], ["a", "s", 2], ["b", "s", 1], ["b", "s", 2],
  ])
})

test("competitive benchmark command materialization keeps argv shell-free and exposes isolated paths", () => {
  assert.deepEqual(materializeCommand(["opencode", "run", "{prompt}", "--dir", "{workspace}", "--home", "{home}"], {
    root: "/repo", workspace: "/tmp/a b", home: "/tmp/home x", prompt: "fix it; echo unsafe", competitor: "a", scenario: "s", run: "1",
  }), ["opencode", "run", "fix it; echo unsafe", "--dir", "/tmp/a b", "--home", "/tmp/home x"])
})

test("competitive benchmark summary is oracle-driven and weighted", () => {
  const results = [
    { competitor: "a", competitorLabel: "A", scenario: "x", category: "correctness", weight: 4, repeat: 1, passed: true },
    { competitor: "a", competitorLabel: "A", scenario: "y", category: "safety", weight: 6, repeat: 1, passed: false, oracle: { exitCode: 1, stderr: "hidden acceptance failed" }, agent: { exitCode: 0 } },
  ]
  const summary = summarize(results)
  assert.equal(summary[0].weightedScore, 0.4)
  assert.equal(summary[0].passRate, 0.5)
  const markdown = renderMarkdown({ generatedAt: "now", manifest: "m.json", results, summary })
  assert.match(markdown, /40\.0%/)
  assert.match(markdown, /hidden acceptance failed/)
  assert.match(markdown, /oracle/)
})

test("competitive benchmark rejects duplicate competitor ids", () => {
  assert.throws(() => validateManifest({ ...manifest, competitors: [manifest.competitors[0], manifest.competitors[0]] }), /duplicate competitor id/)
})

test("competitive benchmark redacts explicit secrets from stored command and output", async () => {
  const secret = "bench-super-secret-value"
  const result = await runCommand([process.execPath, "-e", "console.log(process.env.BENCH_SECRET); console.error(process.env.BENCH_SECRET)"], {
    cwd: process.cwd(),
    env: { ...process.env, BENCH_SECRET: secret },
    timeoutMs: 5_000,
    redactions: [{ name: "BENCH_SECRET", value: secret }],
  })
  assert.equal(result.exitCode, 0)
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret))
  assert.match(result.stdout, /\[REDACTED:BENCH_SECRET\]/)
  assert.match(result.stderr, /\[REDACTED:BENCH_SECRET\]/)
})

test("competitive benchmark timeout terminates the executor instead of hanging the harness", async () => {
  const result = await runCommand([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 100,
    redactions: [],
  })
  assert.equal(result.timedOut, true)
  assert.notEqual(result.signal, null)
})

test("competitive benchmark validates competitor setup commands", () => {
  assert.throws(() => validateManifest({
    ...manifest,
    competitors: [{ id: "a", command: ["tool"], setup: { command: [] } }],
  }), /setup\.command must be a non-empty argv array/)
})

test("redactText prefers explicit labels and handles repeated values", () => {
  assert.equal(redactText("x token123 token123", [{ name: "API_TOKEN", value: "token123" }]), "x [REDACTED:API_TOKEN] [REDACTED:API_TOKEN]")
})

test("competitive benchmark rejects non-object isolated OpenCode config", () => {
  assert.throws(() => validateManifest({
    ...manifest,
    competitors: [{ id: "a", command: ["tool"], opencodeConfig: [] }],
  }), /opencodeConfig must be an object/)
})


test("competitive benchmark fixture digest is deterministic and changes with content", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-digest-"))
  try {
    await writeFile(path.join(dir, "a.txt"), "one\n")
    const first = await digestFixtureTree(dir)
    const second = await digestFixtureTree(dir)
    assert.equal(first, second)
    assert.match(first, /^sha256:[a-f0-9]{64}$/)
    await writeFile(path.join(dir, "a.txt"), "two\n")
    assert.notEqual(await digestFixtureTree(dir), first)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("competitive benchmark metadata rejects secret-looking fields", () => {
  assert.throws(() => validateManifest({ ...manifest, metadata: { model: "provider/model", apiKey: "do-not-store" } }), /looks secret/)
  assert.doesNotThrow(() => validateManifest({ ...manifest, metadata: { opencodeVersion: "1.2.3", model: "provider/model" } }))
})
