import test from "node:test"
import assert from "node:assert/strict"
import { expandRuns, materializeCommand, renderMarkdown, summarize, validateManifest } from "../scripts/competitive-benchmark.mjs"

const manifest = {
  schemaVersion: 1,
  repeats: 2,
  competitors: [{ id: "a", command: ["tool", "{prompt}"] }, { id: "b", command: ["tool", "{prompt}"] }],
  scenarios: [{ id: "s", category: "safety", weight: 5, workspace: "fixture", prompt: "do it", oracle: { command: ["node", "oracle.mjs"] } }],
}

test("competitive benchmark manifest expands deterministic competitor/scenario repeats", () => {
  validateManifest(manifest)
  assert.deepEqual(expandRuns(manifest).map((item) => [item.competitor.id, item.scenario.id, item.repeat]), [
    ["a", "s", 1], ["a", "s", 2], ["b", "s", 1], ["b", "s", 2],
  ])
})

test("competitive benchmark command materialization keeps argv shell-free", () => {
  assert.deepEqual(materializeCommand(["opencode", "run", "{prompt}", "--dir", "{workspace}"], {
    workspace: "/tmp/a b", prompt: "fix it; echo unsafe", competitor: "a", scenario: "s", run: "1",
  }), ["opencode", "run", "fix it; echo unsafe", "--dir", "/tmp/a b"])
})

test("competitive benchmark summary is oracle-driven and weighted", () => {
  const results = [
    { competitor: "a", competitorLabel: "A", scenario: "x", category: "correctness", weight: 4, repeat: 1, passed: true },
    { competitor: "a", competitorLabel: "A", scenario: "y", category: "safety", weight: 6, repeat: 1, passed: false },
  ]
  const summary = summarize(results)
  assert.equal(summary[0].weightedScore, 0.4)
  assert.equal(summary[0].passRate, 0.5)
  const markdown = renderMarkdown({ generatedAt: "now", manifest: "m.json", results, summary })
  assert.match(markdown, /40\.0%/)
  assert.match(markdown, /oracle/)
})

test("competitive benchmark rejects duplicate competitor ids", () => {
  assert.throws(() => validateManifest({ ...manifest, competitors: [manifest.competitors[0], manifest.competitors[0]] }), /duplicate competitor id/)
})
