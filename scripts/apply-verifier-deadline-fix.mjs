import { readFile, writeFile } from "node:fs/promises"

async function patch(path, edits) {
  let source = await readFile(path, "utf8")
  for (const [label, before, after] of edits) {
    if (!source.includes(before)) throw new Error(`${path}: missing patch anchor: ${label}`)
    source = source.replace(before, after)
  }
  await writeFile(path, source, "utf8")
}

await patch("src/opencode/verifier.ts", [
  [
    "deadline constants",
    'export const DEFAULT_VERIFIER_TIMEOUT_MS = 60_000\nconst VERIFIER_CLEANUP_TIMEOUT_MS = 1_500',
    'export const DEFAULT_VERIFIER_TIMEOUT_MS = 180_000\nexport const DEFAULT_VERIFIER_DISPATCH_TIMEOUT_MS = 30_000\nconst VERIFIER_CLEANUP_TIMEOUT_MS = 1_500',
  ],
  [
    "dispatch timeout option",
    'export interface SemanticVerifierOptions {\n  timeoutMs?: number | undefined\n  /** OpenCode model ref in provider/model format. When omitted, small_model/model host config is preferred. */',
    'export interface SemanticVerifierOptions {\n  /** Maximum time to wait for the verifier to inspect the workspace and submit a verdict. */\n  timeoutMs?: number | undefined\n  /** Maximum time for verifier session creation and promptAsync transport dispatch. */\n  dispatchTimeoutMs?: number | undefined\n  /** OpenCode model ref in provider/model format. When omitted, small_model/model host config is preferred. */',
  ],
  [
    "workspace hints helper",
    'function verifierHostEvidence(goal: GoalState, currentMessageID?: string): EvidenceRecord[] {',
    `function verifierWorkspaceHints(goal: GoalState): string[] {\n  const output: string[] = []\n  const seen = new Set<string>()\n  for (const fingerprint of goal.progressFingerprints ?? []) {\n    const text = String(fingerprint || "")\n    if (!text.startsWith("file:")) continue\n    const value = text.slice("file:".length)\n    const separator = value.lastIndexOf(":")\n    if (separator <= 0) continue\n    const relativePath = value.slice(0, separator).trim()\n    if (!relativePath || seen.has(relativePath)) continue\n    seen.add(relativePath)\n    output.push(relativePath)\n  }\n  return output.slice(-48)\n}\n\nfunction verifierHostEvidence(goal: GoalState, currentMessageID?: string): EvidenceRecord[] {`,
  ],
  [
    "workspace hints prompt data",
    '  const hostEvidence = hostEvidenceRecords\n    .map((item) => `- [${item.id}] ${item.summary}`)\n    .join("\\n") || "- none"\n  const request = JSON.stringify({',
    '  const hostEvidence = hostEvidenceRecords\n    .map((item) => `- [${item.id}] ${item.summary}`)\n    .join("\\n") || "- none"\n  const workspaceHints = verifierWorkspaceHints(goal)\n    .map((item) => `- ${item}`)\n    .join("\\n") || "- none"\n  const request = JSON.stringify({',
  ],
  [
    "workspace hints prompt section",
    'Host evidence:\\n${hostEvidence}\\n\\nVerification request:\\n${request}',
    'Host evidence:\\n${hostEvidence}\\n\\nHost-observed workspace mutation hints (navigation only, not proof):\\n${workspaceHints}\\n\\nInspect the mutation-hint paths first when they are relevant. You must still read current file contents yourself; a mutation hint alone never proves a requirement.\\n\\nVerification request:\\n${request}',
  ],
  [
    "resolved deadlines",
    '  const timeoutMs = Number.isFinite(options.timeoutMs) && Number(options.timeoutMs) > 0\n    ? Number(options.timeoutMs)\n    : DEFAULT_VERIFIER_TIMEOUT_MS\n  const explicitModel = normalizeModelRef(options.model)',
    '  const timeoutMs = Number.isFinite(options.timeoutMs) && Number(options.timeoutMs) > 0\n    ? Number(options.timeoutMs)\n    : DEFAULT_VERIFIER_TIMEOUT_MS\n  const dispatchTimeoutMs = Number.isFinite(options.dispatchTimeoutMs) && Number(options.dispatchTimeoutMs) > 0\n    ? Number(options.dispatchTimeoutMs)\n    : Math.min(DEFAULT_VERIFIER_DISPATCH_TIMEOUT_MS, timeoutMs)\n  const explicitModel = normalizeModelRef(options.model)',
  ],
  [
    "session creation deadline",
    '          Promise.resolve().then(() => client.session.create({ body: { parentID: parentSessionID, title: "Goal verification" } })),\n          timeoutMs,\n        ))',
    '          Promise.resolve().then(() => client.session.create({ body: { parentID: parentSessionID, title: "Goal verification" } })),\n          dispatchTimeoutMs,\n        ))',
  ],
  [
    "async dispatch deadline",
    '            Promise.resolve().then(() => client.session.promptAsync({ path: { id: childID }, body })),\n            timeoutMs,\n          )',
    '            Promise.resolve().then(() => client.session.promptAsync({ path: { id: childID }, body })),\n            dispatchTimeoutMs,\n          )',
  ],
  [
    "runtime deadline getter",
    '    get timeout() { return timeoutMs },\n  }',
    '    get timeout() { return timeoutMs },\n    get dispatchTimeout() { return dispatchTimeoutMs },\n  }',
  ],
])

await patch("src/opencode/plugin.ts", [
  [
    "plugin dispatch timeout option",
    '  /** Hard semantic verifier deadline in milliseconds. */\n  verifierTimeoutMs?: number\n}',
    '  /** Semantic verifier result deadline in milliseconds. */\n  verifierTimeoutMs?: number\n  /** Verifier session-create/promptAsync transport deadline in milliseconds. */\n  verifierDispatchTimeoutMs?: number\n}',
  ],
  [
    "plugin dispatch timeout env",
    '    timeoutMs: optionNumber(options.verifierTimeoutMs) ?? optionNumber(process.env.OPENCODE_GOAL_VERIFIER_TIMEOUT_MS),\n  })',
    '    timeoutMs: optionNumber(options.verifierTimeoutMs) ?? optionNumber(process.env.OPENCODE_GOAL_VERIFIER_TIMEOUT_MS),\n    dispatchTimeoutMs: optionNumber(options.verifierDispatchTimeoutMs) ?? optionNumber(process.env.OPENCODE_GOAL_VERIFIER_DISPATCH_TIMEOUT_MS),\n  })',
  ],
])

await patch("test/verifier-timeout.test.mjs", [
  [
    "deadline imports",
    'import { createSemanticVerifierRuntime, SemanticVerifierUnavailableError } from "../dist/opencode/verifier.js"',
    'import { createSemanticVerifierRuntime, DEFAULT_VERIFIER_DISPATCH_TIMEOUT_MS, DEFAULT_VERIFIER_TIMEOUT_MS, SemanticVerifierUnavailableError } from "../dist/opencode/verifier.js"',
  ],
  [
    "default deadline test insertion",
    'test("hung semantic verifier aborts quickly instead of wedging the parent Goal turn", async () => {',
    `test("default verifier deadlines allow slow semantic audits without leaving transport unbounded", () => {\n  const runtime = createSemanticVerifierRuntime({ session: {} }, process.cwd())\n  assert.equal(DEFAULT_VERIFIER_TIMEOUT_MS, 180_000)\n  assert.equal(DEFAULT_VERIFIER_DISPATCH_TIMEOUT_MS, 30_000)\n  assert.equal(runtime.timeout, 180_000)\n  assert.equal(runtime.dispatchTimeout, 30_000)\n})\n\ntest("hung semantic verifier aborts quickly instead of wedging the parent Goal turn", async () => {`,
  ],
  [
    "mutation hint fixture",
    '    revisionTurnBaseline: 5,\n  }), { currentMessageID: "current-turn" })',
    '    revisionTurnBaseline: 5,\n    progressFingerprints: [`file:ExportGPT-Plus/manifest.json:${"a".repeat(64)}`],\n  }), { currentMessageID: "current-turn" })',
  ],
  [
    "mutation hint assertions",
    '  assert.match(promptText, /Temporal\\/process requirements such as doing an action across N distinct turns are not proven by a final file value alone/)\n})',
    '  assert.match(promptText, /Temporal\\/process requirements such as doing an action across N distinct turns are not proven by a final file value alone/)\n  assert.match(promptText, /Host-observed workspace mutation hints \\(navigation only, not proof\\):/)\n  assert.match(promptText, /ExportGPT-Plus\\/manifest\\.json/)\n})',
  ],
  [
    "async dispatch split deadline",
    '  const runtime = createSemanticVerifierRuntime(client, process.cwd(), { timeoutMs: 25 })\n  const started = Date.now()\n  await assert.rejects(\n    runtime.verify("parent", semanticGoal()),\n    (error) => error instanceof SemanticVerifierUnavailableError && /semantic verifier timed out after 25ms/.test(error.message),\n  )\n  const elapsed = Date.now() - started\n\n  assert.ok(elapsed < 1_000, `hung async dispatch should release the parent promptly, got ${elapsed}ms`)',
    '  const runtime = createSemanticVerifierRuntime(client, process.cwd(), { timeoutMs: 250, dispatchTimeoutMs: 25 })\n  const started = Date.now()\n  await assert.rejects(\n    runtime.verify("parent", semanticGoal()),\n    (error) => error instanceof SemanticVerifierUnavailableError && /semantic verifier timed out after 25ms/.test(error.message),\n  )\n  const elapsed = Date.now() - started\n\n  assert.ok(elapsed < 1_000, `hung async dispatch should release the parent promptly, got ${elapsed}ms`)',
  ],
])

console.log("applied verifier deadline and workspace-hint fix")
