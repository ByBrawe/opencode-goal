import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCodeGoalPlugin from "../dist/index.js"
import { parseGoalCommand } from "../dist/opencode/command.js"
import { GoalStore } from "../dist/persistence/store.js"

const pastedRunWrapper = [
  "opencode run --auto --dir . @'",
  "Dremall repository üzerinde production geliştirmesine devam edeceksin.",
  "Example tool command: npm test -- --watch=false",
  "'@",
].join("\n")

test("an outer opencode run here-string pasted inside /goal is rejected with actionable syntax guidance", () => {
  assert.throws(
    () => parseGoalCommand(pastedRunWrapper),
    /already in the OpenCode TUI.*remove the opencode run.*paste only the Goal text/i,
  )
})

test("invalid pasted /goal syntax becomes visible output instead of escaping the command hook", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-visible-parse-error-"))
  try {
    const toasts = []
    const client = {
      session: {
        prompt() { return Promise.resolve({}) },
        abort() { return Promise.resolve(true) },
      },
      tui: {
        showToast(arg) {
          toasts.push(arg)
          return Promise.resolve({})
        },
      },
    }
    const hooks = await OpenCodeGoalPlugin({ client, directory: root })
    const output = { parts: [{ type: "text", text: pastedRunWrapper }] }

    await assert.doesNotReject(() => hooks["command.execute.before"]({
      command: "goal",
      sessionID: "bad-wrapper",
      arguments: pastedRunWrapper,
    }, output))

    assert.equal(output.noReply, false)
    assert.match(output.parts[0].text, /Goal command was not run because its arguments are invalid/)
    assert.match(output.parts[0].text, /already in the OpenCode TUI/i)
    assert.match(output.parts[0].text, /No Goal state was changed/)
    assert.ok(toasts.some((item) => item?.body?.variant === "error"))
    assert.equal(await new GoalStore(root).load("bad-wrapper"), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
