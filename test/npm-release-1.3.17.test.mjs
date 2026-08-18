import test from "node:test"
import assert from "node:assert/strict"

const EXPECTED = "1.3.17"
const URL = "https://registry.npmjs.org/%40bybrawe%2Fopencode-goal/1.3.17"

test("npm registry exposes the 1.3.17 stable package and installer bin", async () => {
  const response = await fetch(URL, { signal: AbortSignal.timeout(15_000) })
  assert.equal(response.status, 200, `registry returned HTTP ${response.status}`)
  const manifest = await response.json()
  assert.equal(manifest.version, EXPECTED)
  const bin = manifest.bin?.["opencode-goal"]
  assert.ok(bin === "bin/opencode-goal.js" || bin === "./bin/opencode-goal.js", `unexpected bin: ${bin}`)
})
