import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCodeGoalPlugin from "../dist/index.js"
import { GoalStore } from "../dist/persistence/store.js"
import { observeTodoPlan } from "../dist/runtime/todo-plan.js"

async function readOnlyGoal(root) {
  const dir = path.join(root, ".opencode", "goals")
  const files = (await readdir(dir)).filter((name) => name.endsWith(".json"))
  assert.equal(files.length, 1)
  return JSON.parse(await readFile(path.join(dir, files[0]), "utf8"))
}

function fakeClient() {
  const prompts = []
  let abortCount = 0
  return {
    client: {
      session: {
        prompt(arg) {
          prompts.push(arg)
          return Promise.resolve({})
        },
        abort() {
          abortCount += 1
          return Promise.resolve(true)
        },
      },
      tui: {
        showToast() { return Promise.resolve({}) },
      },
    },
    prompts,
    get abortCount() { return abortCount },
  }
}

async function command(hooks, argumentsText, sessionID = "revision-session") {
  const output = { parts: [{ type: "text", text: argumentsText }] }
  await hooks["command.execute.before"]({ command: "goal", sessionID, arguments: argumentsText }, output)
  return output
}

async function foreground(hooks, text, messageID, sessionID = "revision-session") {
  const output = { message: { id: messageID }, parts: [{ type: "text", text }] }
  await hooks["chat.message"](
    { sessionID, messageID, agent: "build", model: { providerID: "p", modelID: "m" }, variant: "high" },
    output,
  )
  return output
}

async function beginAssistant(hooks, parentID, assistantMessageID, sessionID = "revision-session") {
  await hooks.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: assistantMessageID,
          sessionID,
          parentID,
          role: "assistant",
          time: { created: Date.now() },
          tokens: { input: 0, output: 0, reasoning: 0 },
          cost: 0,
        },
      },
    },
  })
}

async function finishAssistant(hooks, parentID, assistantMessageID, sessionID = "revision-session") {
  await hooks.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: assistantMessageID,
          sessionID,
          parentID,
          role: "assistant",
          time: { created: 1, completed: 2 },
          tokens: { input: 2, output: 3, reasoning: 1 },
          cost: 0.001,
        },
      },
    },
  })
}

test("paused Goal can extend from the exact 100-line foreground user instruction and forces a fresh plan", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-user-revision-"))
  try {
    const fake = fakeClient()
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
    const store = new GoalStore(root)

    await command(hooks, "build the original project")
    let goal = await store.load("revision-session")
    assert.ok(goal)
    goal = observeTodoPlan(goal, [
      { content: "Old plan item", status: "in_progress" },
      { content: "Old verification", status: "pending" },
    ], 200)
    await store.save(goal)
    const budget = { ...goal.budget }
    const usage = { ...goal.usage, seenMessageIDs: [...goal.usage.seenMessageIDs] }

    await command(hooks, "pause")
    const lines = Array.from({ length: 100 }, (_, index) => `${index + 1}. yeni gereksinim ${index + 1}`)
    const instruction = `şimdi bunları da yap:\n${lines.join("\n")}`
    const output = await foreground(hooks, instruction, "human-100")
    assert.equal(output.parts[0].text, instruction, "the raw human text must remain untouched")
    assert.ok(output.parts.some((part) => part?.synthetic === true && /opencode_goal_revise_from_user/.test(part.text ?? "")))

    let persisted = await readOnlyGoal(root)
    assert.equal(persisted.status, "paused", "ordinary foreground chat alone still must not silently mutate lifecycle state")
    assert.equal(persisted.revision, 1)

    await beginAssistant(hooks, "human-100", "assistant-100")
    const result = await hooks.tool.opencode_goal_revise_from_user.execute(
      { mode: "extend" },
      { sessionID: "revision-session", messageID: "assistant-100", agent: "build" },
    )
    assert.match(result, /r1 -> r2 \(extend\)/)
    assert.match(result, /End this assistant turn now/)

    persisted = await readOnlyGoal(root)
    assert.equal(persisted.status, "active")
    assert.equal(persisted.revision, 2)
    assert.equal(persisted.objective, `build the original project\n\nAdditional user instruction:\n${instruction}`)
    for (const line of lines) assert.ok(persisted.objective.includes(line), `missing exact user line: ${line}`)
    assert.equal(persisted.todoPlan, undefined, "a material user revision must force a fresh native Todo plan")
    assert.deepEqual(persisted.budget, budget, "revising scope must not reset execution guards")
    assert.equal(persisted.usage.turns, usage.turns)
    assert.equal(persisted.usage.tokens, usage.tokens)
    assert.equal(persisted.stalledTurns, 0)
    assert.equal(persisted.skipNextStallCheck, true, "the intentional revision-boundary turn must not spend the no-progress budget")

    const replay = await hooks.tool.opencode_goal_revise_from_user.execute(
      { mode: "extend" },
      { sessionID: "revision-session", messageID: "assistant-100", agent: "build" },
    )
    assert.match(replay, /no unconsumed latest foreground human instruction/i)

    await assert.rejects(
      hooks["tool.execute.before"]({ sessionID: "revision-session", callID: "stale-write", tool: "write", args: {} }),
      /End this assistant turn now/i,
      "the pre-revision assistant turn must not mutate the revised Goal",
    )

    await finishAssistant(hooks, "human-100", "assistant-100")
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "revision-session" } } })
    assert.equal(fake.prompts.length, 1)
    assert.match(fake.prompts[0].body.parts[0].text, /Additional user instruction:/)
    assert.match(fake.prompts[0].body.parts[0].text, /100\. yeni gereksinim 100/)

    persisted = await readOnlyGoal(root)
    assert.equal(persisted.status, "active")
    assert.equal(persisted.stalledTurns, 0, "the revision boundary must not become a false no-progress pause")
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test("replace uses only the exact latest human instruction while ordinary active steering remains same-revision until the tool is called", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-user-replace-"))
  try {
    const fake = fakeClient()
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })

    await command(hooks, "finish the old feature")
    const instruction = "eski hedefi bırak; bunun yerine ödeme API'sini bitir ve testlerini çalıştır"
    await foreground(hooks, instruction, "human-replace")

    let persisted = await readOnlyGoal(root)
    assert.equal(persisted.objective, "finish the old feature")
    assert.equal(persisted.revision, 1, "foreground steering is not an implicit contract edit by itself")

    await beginAssistant(hooks, "human-replace", "assistant-replace")
    const result = await hooks.tool.opencode_goal_revise_from_user.execute(
      { mode: "replace" },
      { sessionID: "revision-session", messageID: "assistant-replace", agent: "build" },
    )
    assert.match(result, /r1 -> r2 \(replace\)/)

    persisted = await readOnlyGoal(root)
    assert.equal(persisted.objective, instruction)
    assert.equal(persisted.revision, 2)
    assert.equal(persisted.status, "active")
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test("questions do not mutate paused Goals and short natural resume keeps the same revision without revision authorization", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-user-question-"))
  try {
    const fake = fakeClient()
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })

    await command(hooks, "finish the tracked project")
    await command(hooks, "pause")

    await foreground(hooks, "neden durdu, bana sadece durumu açıklar mısın?", "human-question")
    let persisted = await readOnlyGoal(root)
    assert.equal(persisted.status, "paused")
    assert.equal(persisted.revision, 1)
    assert.equal(persisted.objective, "finish the tracked project")

    await foreground(hooks, "devam et", "human-resume")
    persisted = await readOnlyGoal(root)
    assert.equal(persisted.status, "active")
    assert.equal(persisted.revision, 1, "natural resume continues the same Goal rather than creating a new scope revision")

    await beginAssistant(hooks, "human-resume", "assistant-resume")
    const result = await hooks.tool.opencode_goal_revise_from_user.execute(
      { mode: "extend" },
      { sessionID: "revision-session", messageID: "assistant-resume", agent: "build" },
    )
    assert.match(result, /no unconsumed latest foreground human instruction/i, "natural resume must not become revision authority")
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test("budget and provider usage stop states cannot be implicitly bypassed by a foreground revision", async () => {
  for (const status of ["budget_limited", "usage_limited"]) {
    const root = await mkdtemp(path.join(os.tmpdir(), `opencode-goal-user-limit-${status}-`))
    try {
      const fake = fakeClient()
      const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
      const store = new GoalStore(root)

      await command(hooks, "finish guarded work")
      const goal = await store.load("revision-session")
      assert.ok(goal)
      await store.save({ ...goal, status, stopReason: `${status} test`, updatedAt: Date.now() })

      await foreground(hooks, "buna yeni bir özellik de ekle", `human-${status}`)
      await beginAssistant(hooks, `human-${status}`, `assistant-${status}`)
      const result = await hooks.tool.opencode_goal_revise_from_user.execute(
        { mode: "extend" },
        { sessionID: "revision-session", messageID: `assistant-${status}`, agent: "build" },
      )
      assert.match(result, new RegExp(`status ${status} requires explicit`, "i"))

      const persisted = await readOnlyGoal(root)
      assert.equal(persisted.status, status)
      assert.equal(persisted.revision, 1)
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  }
})
