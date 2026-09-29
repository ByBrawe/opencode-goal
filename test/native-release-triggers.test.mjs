import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

// A source-bound publisher cannot accept a successful older run when a metadata
// or dependency-only release never triggered a required native gate.
for (const file of [
  "opencode2-current-stable.yml",
  "opencode2-todo-materialization-diff.yml",
  "opencode2-unit-handoff.yml",
]) {
  test(`native release gate runs on every main push: ${file}`, async () => {
    const text = await readFile(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8")
    const push = text.match(/^ {2}push:\s*\n((?:^ {4}.*\n|^\s*\n)+)/m)?.[1]
    assert.ok(push, "required workflow must have a main push trigger")
    assert.match(push, /^ {4}branches:\s*\[main\]\s*$/m)
    assert.doesNotMatch(push, /^ {4}paths(?:-ignore)?\s*:/m, "release metadata must not suppress an exact-commit gate")
    assert.match(text, /^permissions:\s*\n {2}contents: read\s*$/m)
  })
}
