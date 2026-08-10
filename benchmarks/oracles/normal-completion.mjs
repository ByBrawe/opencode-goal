import { assertExactFile, fail, pass, requireWorkspace, runNodeTests } from "./_helpers.mjs"

const EXPECTED_TEST = `import test from "node:test"\nimport assert from "node:assert/strict"\nimport { add, multiply } from "../src/math.js"\n\ntest("add handles positive and negative integers", () => {\n  assert.equal(add(2, 3), 5)\n  assert.equal(add(-4, 7), 3)\n})\n\ntest("multiply remains correct", () => {\n  assert.equal(multiply(6, 7), 42)\n})\n`

try {
  const workspace = requireWorkspace()
  await assertExactFile(workspace, "test/math.visible.mjs", EXPECTED_TEST)
  runNodeTests(workspace, "test/math.visible.mjs")
  pass("visible tests pass and the test contract is unchanged")
} catch (error) {
  fail(error)
}
