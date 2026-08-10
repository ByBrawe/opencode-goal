import test from "node:test"
import assert from "node:assert/strict"
import { slugify } from "../src/slug.js"

test("slugify handles a simple phrase", () => {
  assert.equal(slugify("Hello World"), "hello-world")
})
