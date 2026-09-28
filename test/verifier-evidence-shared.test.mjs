import assert from "node:assert/strict"
import test from "node:test"
import * as shared from "../dist/verification/verifier-evidence.js"
import * as legacy from "../dist/opencode/verifier.js"

test("V1 and V2 use the same verifier proof helpers and Error identity", () => {
  for (const name of Object.keys(shared)) assert.strictEqual(legacy[name], shared[name], name)
  const error = new shared.SemanticVerifierUnavailableError("fixture")
  assert.ok(error instanceof legacy.SemanticVerifierUnavailableError)
})
