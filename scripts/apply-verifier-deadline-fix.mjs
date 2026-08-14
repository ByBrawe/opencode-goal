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

await patch("src/runtime/checks.ts", [
  [
    "configured check default",
    'function run(command: string, cwd: string, timeoutMs = 120_000): Promise<{ code: number; output: string }> {',
    'export const DEFAULT_CONFIGURED_CHECK_TIMEOUT_MS = 60 * 60_000\n\nfunction run(command: string, cwd: string, timeoutMs = DEFAULT_CONFIGURED_CHECK_TIMEOUT_MS): Promise<{ code: number; output: string }> {',
  ],
  [
    "configured check option",
    'export async function runConfiguredChecks(goal: GoalState, cwd: string): Promise<GoalState> {\n  let next = goal',
    'export async function runConfiguredChecks(goal: GoalState, cwd: string, options: { timeoutMs?: number } = {}): Promise<GoalState> {\n  const timeoutMs = Number.isFinite(options.timeoutMs) && Number(options.timeoutMs) > 0\n    ? Number(options.timeoutMs)\n    : DEFAULT_CONFIGURED_CHECK_TIMEOUT_MS\n  let next = goal',
  ],
  [
    "configured check run timeout",
    '    const result = await run(requirement.command!, cwd)',
    '    const result = await run(requirement.command!, cwd, timeoutMs)',
  ],
])

await patch("src/opencode/plugin.ts", [
  [
    "plugin timeout options",
    '  /** Hard semantic verifier deadline in milliseconds. */\n  verifierTimeoutMs?: number\n}',
    '  /** Semantic verifier result deadline in milliseconds. */\n  verifierTimeoutMs?: number\n  /** Verifier session-create/promptAsync transport deadline in milliseconds. */\n  verifierDispatchTimeoutMs?: number\n  /** Timeout for host-run completion checks such as Gradle/Xcode builds. */\n  checkTimeoutMs?: number\n}',
  ],
  [
    "plugin timeout envs",
    '    timeoutMs: optionNumber(options.verifierTimeoutMs) ?? optionNumber(process.env.OPENCODE_GOAL_VERIFIER_TIMEOUT_MS),\n  })\n  const ownership = new TurnOwnership()',
    '    timeoutMs: optionNumber(options.verifierTimeoutMs) ?? optionNumber(process.env.OPENCODE_GOAL_VERIFIER_TIMEOUT_MS),\n    dispatchTimeoutMs: optionNumber(options.verifierDispatchTimeoutMs) ?? optionNumber(process.env.OPENCODE_GOAL_VERIFIER_DISPATCH_TIMEOUT_MS),\n  })\n  const configuredCheckTimeoutMs = optionNumber(options.checkTimeoutMs) ?? optionNumber(process.env.OPENCODE_GOAL_CHECK_TIMEOUT_MS)\n  const ownership = new TurnOwnership()',
  ],
  [
    "configured checks deadline",
    '          let evaluated = await runConfiguredChecks(snapshot, directory)',
    '          let evaluated = await runConfiguredChecks(snapshot, directory, { timeoutMs: configuredCheckTimeoutMs })',
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

await writeFile("test/check-timeout.test.mjs", `import test from "node:test"\nimport assert from "node:assert/strict"\nimport { DEFAULT_CONFIGURED_CHECK_TIMEOUT_MS, runConfiguredChecks } from "../dist/runtime/checks.js"\n\nfunction commandGoal(command) {\n  const now = Date.now()\n  return {\n    schemaVersion: 1,\n    id: "goal-check-timeout",\n    sessionID: "parent",\n    objective: "verify slow build support",\n    revision: 1,\n    status: "active",\n    requirements: [{\n      id: "req-check",\n      text: \`Verification command passes: \${command}\`,\n      required: true,\n      status: "pending",\n      evidenceIDs: [],\n      verification: "command",\n      source: "check",\n      command,\n      updatedAt: now,\n    }],\n    evidence: [],\n    checks: [command],\n    usage: { turns: 0, tokens: 0, cost: 0, runtimeMs: 0, seenMessageIDs: [] },\n    budget: { maxTurns: 30, maxTokens: 400000, maxCost: 0, maxRuntimeMs: 3600000 },\n    progressRevision: 0,\n    observedProgressRevision: 0,\n    progressFingerprints: [],\n    stalledTurns: 0,\n    progressNotes: [],\n    createdAt: now,\n    updatedAt: now,\n  }\n}\n\ntest("configured completion checks allow hour-scale builds by default", () => {\n  assert.equal(DEFAULT_CONFIGURED_CHECK_TIMEOUT_MS, 60 * 60_000)\n})\n\ntest("configured completion check timeout remains explicitly overridable", async () => {\n  const command = \`\"\${process.execPath}\" -e \"setTimeout(() => {}, 500)\"\`\n  const started = Date.now()\n  const result = await runConfiguredChecks(commandGoal(command), process.cwd(), { timeoutMs: 25 })\n  const elapsed = Date.now() - started\n  assert.ok(elapsed < 2_000, \`overridden check timeout should stop a hung check promptly, got \${elapsed}ms\`)\n  assert.equal(result.requirements[0].status, "failed")\n  assert.equal(result.evidence.at(-1)?.passed, false)\n})\n`, "utf8")

console.log("applied verifier deadlines, workspace hints, and slow build timeout support")
