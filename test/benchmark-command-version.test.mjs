import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { assertCommandVersion, extractSemver } from "../scripts/benchmark/assert-command-version.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("benchmark command version gate extracts and requires the exact semantic version", async () => {
  assert.equal(extractSemver("OpenCode v1.17.15\n"), "1.17.15")
  assert.equal(extractSemver("tool 1.17.15-beta.2 ready"), "1.17.15-beta.2")
  assert.equal(extractSemver("no version here"), null)

  const actual = await assertCommandVersion(process.execPath, "1.17.15", ["-e", "console.log('OpenCode v1.17.15')"])
  assert.equal(actual, "1.17.15")
  await assert.rejects(
    assertCommandVersion(process.execPath, "1.17.14", ["-e", "console.log('OpenCode v1.17.15')"]),
    /version mismatch: expected 1\.17\.14, got 1\.17\.15/,
  )
  await assert.rejects(
    assertCommandVersion(process.execPath, "1.17.15", ["-e", "console.log('unknown')"]),
    /did not contain a semantic version/,
  )
})

test("cross-plugin sequence manifest gates every competitor on the pinned OpenCode host version", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "benchmarks", "ordered-sequence.cross-plugin.example.json"), "utf8"))
  assert.equal(manifest.metadata.opencodeVersion, "1.17.15")
  for (const competitor of manifest.competitors) {
    assert.deepEqual(competitor.setup?.command, [
      "node",
      "{root}/scripts/benchmark/assert-command-version.mjs",
      "opencode",
      "1.17.15",
      "--version",
    ])
    assert.equal(competitor.setup?.timeoutMs, 30000)
  }
})
