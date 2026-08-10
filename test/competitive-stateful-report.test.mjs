import test from "node:test"
import assert from "node:assert/strict"
import { renderMarkdown, summarize } from "../scripts/competitive-benchmark.mjs"

test("stateful benchmark report preserves weighted summary and names intermediate invariant failures", () => {
  const results = [
    {
      competitor: "a",
      competitorLabel: "A",
      scenario: "ordered",
      category: "workflow",
      weight: 5,
      repeat: 1,
      passed: false,
      infrastructureFailure: false,
      agent: { exitCode: 0 },
      agentSteps: [{ id: "queue-second", index: 1, agent: { exitCode: 0 } }],
      stepOracles: [{
        id: "queue-second",
        index: 1,
        expected: "fail",
        actual: "pass",
        matched: false,
        oracle: { exitCode: 0, stdout: "unexpected early mutation", stderr: "", timedOut: false, spawnError: null },
      }],
      stepFailure: { id: "queue-second", index: 1, expected: "fail", actual: "pass" },
      oracle: { exitCode: 0, stdout: "final state later became green", stderr: "", timedOut: false, spawnError: null },
    },
    {
      competitor: "a",
      competitorLabel: "A",
      scenario: "normal",
      category: "correctness",
      weight: 5,
      repeat: 1,
      passed: true,
      infrastructureFailure: false,
      agent: { exitCode: 7 },
      agentSteps: [{ id: "agent", index: 0, agent: { exitCode: 7 } }],
      stepOracles: [],
      stepFailure: null,
      oracle: { exitCode: 0, stdout: "oracle pass", stderr: "", timedOut: false, spawnError: null },
    },
  ]

  const summary = summarize(results)
  assert.equal(summary[0].weightedScore, 0.5)
  assert.equal(summary[0].weightedPassed, 5)
  assert.equal(summary[0].weightedTotal, 10)

  const markdown = renderMarkdown({
    generatedAt: "now",
    manifest: "stateful.json",
    manifestDigest: "sha256:test",
    results,
    summary,
  })
  assert.match(markdown, /step queue-second oracle expected FAIL but got PASS/)
  assert.match(markdown, /unexpected early mutation/)
  assert.doesNotMatch(markdown, /final state later became green.*Failure/i, "later final green state must not replace the intermediate failure reason")
  assert.match(markdown, /Agent narration and agent process exit codes do not prove task success/)
})
