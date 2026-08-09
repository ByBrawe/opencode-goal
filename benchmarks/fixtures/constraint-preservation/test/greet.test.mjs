import test from "node:test"
import assert from "node:assert/strict"
import { greet } from "../src/public-api.js"

test("greet trims surrounding whitespace while preserving the caller's case", () => {
  assert.equal(greet("  Ada  "), "Hello, Ada!")
})
