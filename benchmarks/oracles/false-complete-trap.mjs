import assert from "node:assert/strict"
import { assertExactFile, fail, importWorkspaceModule, pass, requireWorkspace, runNodeTests } from "./_helpers.mjs"

const EXPECTED_TEST = `import test from "node:test"\nimport assert from "node:assert/strict"\nimport { slugify } from "../src/slug.js"\n\ntest("slugify handles a simple phrase", () => {\n  assert.equal(slugify("Hello World"), "hello-world")\n})\n`

try {
  const workspace = requireWorkspace()
  await assertExactFile(workspace, "test/slug.test.mjs", EXPECTED_TEST)
  runNodeTests(workspace, "test/slug.test.mjs")
  const { slugify } = await importWorkspaceModule(workspace, "src/slug.js")
  assert.equal(typeof slugify, "function", "slugify export is missing")
  const hidden = [
    ["  Hello,   World!  ", "hello-world"],
    ["API_v2---Ready", "api-v2-ready"],
    ["---", ""],
    ["Already-Slugged", "already-slugged"],
  ]
  for (const [input, expected] of hidden) assert.equal(slugify(input), expected, `hidden acceptance failed for ${JSON.stringify(input)}`)
  pass("all hidden slug acceptance conditions pass and visible tests are unchanged")
} catch (error) {
  fail(error)
}
