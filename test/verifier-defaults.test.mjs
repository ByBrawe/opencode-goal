import test from "node:test"
import assert from "node:assert/strict"
import {
  applySemanticVerifierTimeoutDefault,
  DEFAULT_SEMANTIC_VERIFIER_TIMEOUT_MS,
} from "../dist/opencode/verifier-defaults.js"

test("semantic verifier gets a five-minute default when no override is configured", () => {
  const previous = process.env.OPENCODE_GOAL_VERIFIER_TIMEOUT_MS
  delete process.env.OPENCODE_GOAL_VERIFIER_TIMEOUT_MS
  try {
    assert.equal(DEFAULT_SEMANTIC_VERIFIER_TIMEOUT_MS, 5 * 60_000)
    assert.equal(applySemanticVerifierTimeoutDefault({}).verifierTimeoutMs, 5 * 60_000)
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_GOAL_VERIFIER_TIMEOUT_MS
    else process.env.OPENCODE_GOAL_VERIFIER_TIMEOUT_MS = previous
  }
})

test("explicit semantic verifier timeout remains authoritative", () => {
  const result = applySemanticVerifierTimeoutDefault({ verifierTimeoutMs: 42_000, marker: true })
  assert.equal(result.verifierTimeoutMs, 42_000)
  assert.equal(result.marker, true)
})

test("environment semantic verifier timeout remains authoritative", () => {
  const previous = process.env.OPENCODE_GOAL_VERIFIER_TIMEOUT_MS
  process.env.OPENCODE_GOAL_VERIFIER_TIMEOUT_MS = "420000"
  try {
    const options = {}
    const result = applySemanticVerifierTimeoutDefault(options)
    assert.equal(result, options, "wrapper should leave options untouched so the core plugin can consume the env override")
    assert.equal(result.verifierTimeoutMs, undefined)
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_GOAL_VERIFIER_TIMEOUT_MS
    else process.env.OPENCODE_GOAL_VERIFIER_TIMEOUT_MS = previous
  }
})

test("invalid timeout overrides fall back to the safe default", () => {
  const previous = process.env.OPENCODE_GOAL_VERIFIER_TIMEOUT_MS
  process.env.OPENCODE_GOAL_VERIFIER_TIMEOUT_MS = "not-a-number"
  try {
    assert.equal(applySemanticVerifierTimeoutDefault({ verifierTimeoutMs: 0 }).verifierTimeoutMs, 5 * 60_000)
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_GOAL_VERIFIER_TIMEOUT_MS
    else process.env.OPENCODE_GOAL_VERIFIER_TIMEOUT_MS = previous
  }
})
