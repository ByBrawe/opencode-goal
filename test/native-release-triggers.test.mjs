import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

function assertMainPush(source) {
  // Git checks these files out as CRLF on Windows. Line endings do not
  // change YAML trigger semantics, and must not create a false gate failure.
  const text = source.replace(/\r\n/g, "\n")
  const lines = text.split("\n")
  const start = lines.indexOf("  push:")
  assert.notEqual(start, -1, "required workflow must have a main push trigger")
  const block = []
  for (const line of lines.slice(start + 1)) {
    if (/^\S|^ {1,2}\S/.test(line)) break
    block.push(line)
  }
  const push = block.join("\n")
  assert.match(push, /^ {4}branches:\s*\[main\]\s*$/m)
  assert.doesNotMatch(push, /^ {4}paths(?:-ignore)?\s*:/m, "release metadata must not suppress an exact-commit gate")
  assert.match(text, /^permissions:\s*\n {2}contents: read\s*$/m)
}

for (const file of [
  "opencode2-current-stable.yml",
  "opencode2-todo-materialization-diff.yml",
  "opencode2-unit-handoff.yml",
]) {
  test(`native release gate runs on every main push: ${file}`, async () => {
    const text = await readFile(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8")
    assertMainPush(text)
  })
}

for (const ending of ["\n", "\r\n"]) {
  test(`release trigger validation preserves all invariants with ${ending === "\n" ? "LF" : "CRLF"}`, () => {
    const source = ["name: fixture", "on:", "  push:", "    branches: [main]", "  pull_request:", "    paths: [src/**]", "permissions:", "  contents: read", ""].join(ending)
    assert.doesNotThrow(() => assertMainPush(source))
    assert.throws(() => assertMainPush(source.replace("  push:", "  pull_request_target:")), /main push trigger/)
    assert.throws(() => assertMainPush(source.replace("[main]", "[release]")))
    assert.throws(() => assertMainPush(source.replace("    branches: [main]", `    branches: [main]${ending}    paths: [src/**]`)), /release metadata/)
    assert.throws(() => assertMainPush(source.replace("    branches: [main]", `    branches: [main]${ending}    paths-ignore: [package.json]`)), /release metadata/)
    assert.throws(() => assertMainPush(source.replace("  contents: read", "  contents: write")))
  })
}
