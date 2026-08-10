import { assertExactFile, fail, pass, requireWorkspace, runNodeTests } from "./_helpers.mjs"

const EXPECTED_PUBLIC_API = `import { makeGreeting } from "./internal.js"\n\nexport function greet(name) {\n  return makeGreeting(name)\n}\n`
const EXPECTED_TEST = `import test from "node:test"\nimport assert from "node:assert/strict"\nimport { greet } from "../src/public-api.js"\n\ntest("greet trims surrounding whitespace while preserving the caller's case", () => {\n  assert.equal(greet("  Ada  "), "Hello, Ada!")\n})\n`

try {
  const workspace = requireWorkspace()
  await assertExactFile(workspace, "src/public-api.js", EXPECTED_PUBLIC_API)
  await assertExactFile(workspace, "test/greet.visible.mjs", EXPECTED_TEST)
  runNodeTests(workspace, "test/greet.visible.mjs")
  pass("behavior is fixed while the frozen public API and tests remain byte-for-byte unchanged")
} catch (error) {
  fail(error)
}
