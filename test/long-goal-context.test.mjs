import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCodeGoalPlugin, { createGoal, pauseGoal } from "../dist/index.js"
import { GoalStore } from "../dist/persistence/store.js"
import { compactionContext, continuationPrompt, continuationReminder } from "../dist/opencode/prompt.js"

function occurrences(text, needle) {
  return text.split(needle).length - 1
}

const hugeObjective = `LONG-CONTRACT-BEGIN\n${"production requirement line with --example flag\n".repeat(900)}LONG-CONTRACT-END`

test("a huge Goal contract is anchored once, then omitted from repeated autonomous reminders", () => {
  const fresh = createGoal({ sessionID: "long-context", objective: hugeObjective, now: 100 })
  const anchor = continuationPrompt(fresh)
  assert.equal(occurrences(anchor, hugeObjective), 1, "objective-derived requirement must not duplicate the full objective in the anchor")

  const progressed = {
    ...fresh,
    usage: { ...fresh.usage, turns: 1 },
  }
  const reminder = continuationPrompt(progressed)
  assert.equal(reminder, continuationReminder(progressed))
  assert.equal(occurrences(reminder, hugeObjective), 0, "autonomous continuation history must not append the huge contract again")
  assert.ok(reminder.length < 5000, `compact reminder unexpectedly grew to ${reminder.length} characters`)
  assert.match(reminder, /full user-authored objective, constraints, and requirement text were already supplied/i)

  const compacted = compactionContext(progressed)
  assert.equal(occurrences(compacted, hugeObjective), 1, "compaction must re-anchor the full contract exactly once")
})

test("paused model-resume routing uses only a bounded objective preview and never echoes the full huge Goal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-long-resume-"))
  const sessionID = "long-resume"
  try {
    const store = new GoalStore(root)
    await store.save(pauseGoal(createGoal({ sessionID, objective: hugeObjective }), "Paused after no progress"))
    const hooks = await OpenCodeGoalPlugin({
      directory: root,
      client: {
        session: {
          prompt() { return Promise.resolve({}) },
          abort() { return Promise.resolve(true) },
        },
      },
    })

    const output = { system: ["base system"] }
    await hooks["experimental.chat.system.transform"]({ sessionID }, output)
    assert.ok(output.system[0].length < 2000, `paused routing context unexpectedly grew to ${output.system[0].length} characters`)
    assert.equal(output.system[0].includes(hugeObjective), false)
    assert.match(output.system[0], /Goal objective preview:/)

    const result = String(await hooks.tool.opencode_goal_resume.execute({}, {
      sessionID,
      messageID: "routing-assistant",
      agent: "build",
    }))
    assert.equal(result.includes(hugeObjective), false)
    assert.ok(result.length < 1000)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
