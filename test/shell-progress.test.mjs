import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCodeGoalPlugin, {
  shellActivityFingerprint,
  shellObservationFingerprint,
  shellProcessExited,
  shellResultFingerprint,
} from "../dist/index.js"

function fakeClient() {
  return {
    session: {
      prompt() { return Promise.resolve({}) },
      abort() { return Promise.resolve(true) },
    },
  }
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function readOnlyGoal(root) {
  const dir = path.join(root, ".opencode", "goals")
  const files = (await readdir(dir)).filter((name) => name.endsWith(".json"))
  assert.equal(files.length, 1)
  return JSON.parse(await readFile(path.join(dir, files[0]), "utf8"))
}

async function createGoal(hooks, sessionID = "session-1") {
  const output = { parts: [{ type: "text", text: "raw args" }] }
  await hooks["command.execute.before"](
    { command: "goal", sessionID, arguments: "run a shell-heavy research pipeline" },
    output,
  )
  assert.match(output.parts[0].text, /Continue working toward the active OpenCode goal/)
}

async function runShell(hooks, {
  sessionID = "session-1",
  callID,
  command,
  exit = 0,
  output = "completed",
  mutate,
}) {
  await hooks["tool.execute.before"]({ tool: "bash", sessionID, callID })
  if (mutate) await mutate()
  await hooks["tool.execute.after"](
    { tool: "bash", sessionID, callID, args: { command } },
    { title: "bash", output, metadata: { exit, output } },
  )
}

async function closeTurn(hooks, sessionID = "session-1") {
  await hooks.event({ event: { type: "session.idle", properties: { sessionID } } })
  await tick()
}

test("shell fingerprints normalize input and never expose command/output text", () => {
  const one = shellActivityFingerprint({ command: "npm run quality\r\n" })
  const two = shellActivityFingerprint({ command: "npm run quality\n" })
  assert.equal(one, two)
  assert.match(one, /^shell:[a-f0-9]{64}$/)
  assert.doesNotMatch(one, /npm run quality/)
  assert.equal(shellActivityFingerprint({ command: "   " }), undefined)

  const args = { command: "npm run quality -- --token TOP_SECRET" }
  const output = { metadata: { exit: 0, output: "PRIVATE_RESULT" } }
  const observation = shellObservationFingerprint(args, output)
  assert.match(observation, /^shell-observation:[a-f0-9]{64}$/)
  assert.doesNotMatch(observation, /TOP_SECRET|PRIVATE_RESULT/)
  assert.notEqual(
    shellObservationFingerprint(args, { metadata: { exit: 0, output: "DIFFERENT_RESULT" } }),
    observation,
    "the same command with a new host observation should be distinguishable",
  )
  assert.notEqual(
    shellResultFingerprint(args, output, "workspace:one"),
    shellResultFingerprint(args, output, "workspace:two"),
    "the same command/output with a new workspace state should be distinguishable",
  )
})

test("shell process outcome counts only real process exits", () => {
  assert.equal(shellProcessExited({ metadata: { exit: 0 } }), true)
  assert.equal(shellProcessExited({ metadata: { exit: 17 } }), true, "nonzero process exit is still a completed diagnostic action")
  assert.equal(shellProcessExited({ metadata: { exit: null } }), false, "OpenCode uses null for timeout/abort")
  assert.equal(shellProcessExited({ metadata: {} }), false)
  assert.equal(shellProcessExited(undefined), false)
})

test("distinct Goal-owned shell observations count as host progress while identical repeats deduplicate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-shell-progress-"))
  try {
    const hooks = await OpenCodeGoalPlugin({ client: fakeClient(), directory: root })
    await createGoal(hooks)

    const before = await readOnlyGoal(root)
    await runShell(hooks, { callID: "shell-1", command: "npm run quality -- --token TOP_SECRET" })

    let goal = await readOnlyGoal(root)
    assert.equal(goal.progressRevision, before.progressRevision + 1)
    assert.match(goal.progressNotes.at(-1).summary, /Goal-owned shell command completed/)
    assert.doesNotMatch(JSON.stringify(goal.progressNotes), /TOP_SECRET/)
    assert.doesNotMatch(JSON.stringify(goal.progressFingerprints), /TOP_SECRET/)

    await runShell(hooks, { callID: "shell-2", command: "npm run quality -- --token TOP_SECRET" })
    goal = await readOnlyGoal(root)
    assert.equal(goal.progressRevision, before.progressRevision + 1, "the same shell observation must not manufacture repeated progress")

    await runShell(hooks, { callID: "shell-3", command: "npm run quality -- --token TOP_SECRET", output: "new diagnostics" })
    goal = await readOnlyGoal(root)
    assert.equal(goal.progressRevision, before.progressRevision + 2, "a changed shell observation counts once")

    await runShell(hooks, { callID: "shell-4", command: "npm run typecheck", exit: 2 })
    goal = await readOnlyGoal(root)
    assert.equal(goal.progressRevision, before.progressRevision + 3, "a distinct exited shell action counts once even when it reports a diagnostic failure")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("same shell command and output can make progress when final workspace state changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-shell-workspace-progress-"))
  try {
    const hooks = await OpenCodeGoalPlugin({ client: fakeClient(), directory: root })
    await createGoal(hooks)
    await closeTurn(hooks)

    const captures = path.join(root, "captures")
    await mkdir(captures, { recursive: true })
    const command = "node tooling/capture.mjs --next-batch"

    for (let index = 0; index < 3; index += 1) {
      await runShell(hooks, {
        callID: `capture-${index + 1}`,
        command,
        output: "capture batch complete",
        mutate: async () => {
          await writeFile(path.join(captures, `shot-${index + 1}.png`), `capture-${index + 1}\n`)
        },
      })
      await closeTurn(hooks)
      const goal = await readOnlyGoal(root)
      assert.equal(goal.status, "active", `workspace-mutating repeat ${index + 1} must remain active`)
      assert.equal(goal.stalledTurns, 0)
      assert.equal(goal.observedProgressRevision, goal.progressRevision)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("three shell-only continuation turns do not false-pause, while repeated no-op shell observations still stall", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-shell-stall-"))
  try {
    const hooks = await OpenCodeGoalPlugin({ client: fakeClient(), directory: root })
    await createGoal(hooks)
    await closeTurn(hooks)

    const commands = [
      "node tooling/capture.mjs --batch p0",
      "node tooling/quality.mjs --captures",
      "node tooling/normalize.mjs --move-captures",
    ]

    for (const [index, command] of commands.entries()) {
      await runShell(hooks, { callID: `progress-${index + 1}`, command })
      await closeTurn(hooks)
      const goal = await readOnlyGoal(root)
      assert.equal(goal.status, "active", `distinct shell progress turn ${index + 1} must stay active`)
      assert.equal(goal.stalledTurns, 0, `distinct shell progress turn ${index + 1} must reset stalledTurns`)
      assert.equal(goal.observedProgressRevision, goal.progressRevision)
    }

    const progressAfterDistinctWork = (await readOnlyGoal(root)).progressRevision
    const repeated = "node tooling/quality.mjs --captures"
    for (let index = 0; index < 3; index += 1) {
      await runShell(hooks, { callID: `repeat-${index + 1}`, command: repeated })
      await closeTurn(hooks)
      const goal = await readOnlyGoal(root)
      assert.equal(goal.progressRevision, progressAfterDistinctWork, "repeated identical shell observation must not create fresh progress")
      if (index < 2) {
        assert.equal(goal.status, "active")
        assert.equal(goal.stalledTurns, index + 1)
      } else {
        assert.equal(goal.status, "paused")
        assert.equal(goal.stalledTurns, 3)
        assert.match(goal.stopReason, /3 continuation turns without host-observed progress/)
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("three distinct timed-out shell turns cannot evade the stall guard", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-shell-timeout-"))
  try {
    const hooks = await OpenCodeGoalPlugin({ client: fakeClient(), directory: root })
    await createGoal(hooks)
    await closeTurn(hooks)

    const baseline = (await readOnlyGoal(root)).progressRevision
    for (let index = 0; index < 3; index += 1) {
      await runShell(hooks, {
        callID: `timeout-${index + 1}`,
        command: `node tooling/hang-${index + 1}.mjs`,
        exit: null,
      })
      await closeTurn(hooks)
      const goal = await readOnlyGoal(root)
      assert.equal(goal.progressRevision, baseline, "timeout/abort metadata must not create shell progress")
      if (index < 2) {
        assert.equal(goal.status, "active")
        assert.equal(goal.stalledTurns, index + 1)
      } else {
        assert.equal(goal.status, "paused")
        assert.equal(goal.stalledTurns, 3)
        assert.match(goal.stopReason, /3 continuation turns without host-observed progress/)
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("shell completion from an older Goal revision cannot mark the edited Goal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-shell-stale-"))
  try {
    const hooks = await OpenCodeGoalPlugin({ client: fakeClient(), directory: root })
    await createGoal(hooks)

    await hooks["tool.execute.before"]({ tool: "bash", sessionID: "session-1", callID: "old-shell" })

    const editOutput = { parts: [{ type: "text", text: "raw edit" }] }
    await hooks["command.execute.before"](
      { command: "goal", sessionID: "session-1", arguments: "edit run the revised research pipeline" },
      editOutput,
    )
    const edited = await readOnlyGoal(root)
    assert.equal(edited.revision, 2)

    await hooks["tool.execute.after"](
      { tool: "bash", sessionID: "session-1", callID: "old-shell", args: { command: "npm run long-generator" } },
      { title: "bash", output: "completed late", metadata: { exit: 0, output: "completed late" } },
    )

    const after = await readOnlyGoal(root)
    assert.equal(after.revision, 2)
    assert.equal(after.progressRevision, edited.progressRevision, "stale shell work must not mutate the new Goal revision")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
