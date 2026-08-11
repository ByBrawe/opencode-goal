import test from "node:test"
import assert from "node:assert/strict"
import { normalizeLabel } from "../src/label.js"

test("normalizeLabel follows the documented public contract", () => {
  assert.equal(normalizeLabel("  Hello   World  "), "hello-world")
  assert.equal(normalizeLabel("Already Clean"), "already-clean")
})
