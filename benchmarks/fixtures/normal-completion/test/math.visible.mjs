import test from "node:test"
import assert from "node:assert/strict"
import { add, multiply } from "../src/math.js"

test("add handles positive and negative integers", () => {
  assert.equal(add(2, 3), 5)
  assert.equal(add(-4, 7), 3)
})

test("multiply remains correct", () => {
  assert.equal(multiply(6, 7), 42)
})
