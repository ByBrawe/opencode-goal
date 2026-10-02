import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCode2GoalsExperimental, {
  OPENCODE2_AUTONOMOUS_ENV,
  OPENCODE2_DIRECT_LIFECYCLE_ENV,
} from "../dist/opencode2/experimental.js"
import { createGoal } from "../dist/domain/goal.js"
import { GoalStore } from "../dist/persistence/store.js"

function fakeV2EventContext(directory) {
  const hooks = new Map()
  const prompts = []
  const contextBySession = new Map()
  const queued = []
  const waiters = []
  let promptCounter = 0

  const rememberUser = (sessionID, id, text, metadata = {}) => {
    let messages = contextBySession.get(sessionID)
    if (!messages) {
      messages = new Map()
      contextBySession.set(sessionID, messages)
    }
    messages.set(id, {
      info: {
        id,
        role: "user",
        metadata: { ...metadata },
      },
      parts: [{ type: "text", text }],
    })
  }

  const host = {
    ctx: {
      location: { directory },
      options: {},
      command: {
        async transform(callback) {
          await callback({ add() {} })
        },
      },
      session: {
        async get({ sessionID }) {
          return { id: sessionID, location: { directory } }
        },
        async context({ sessionID }) {
          return [...(contextBySession.get(sessionID)?.values() ?? [])]
        },
        async hook(name, callback) {
          hooks.set(name, callback)
        },
        async prompt(input) {
          const id = input.id ?? `user-message-${++promptCounter}`
          prompts.push({ ...input, returnedID: id })
          rememberUser(input.sessionID, id, input.text, input.metadata)
          return { id }
        },
        async interrupt() {
          return { interrupted: true }
        },
      },
      tool: {
        async transform(callback) {
          await callback({ add() {} })
        },
      },
      event: {
        subscribe({ signal } = {}) {
          return {
            [Symbol.asyncIterator]() { return this },
            next() {
              if (signal?.aborted) return Promise.resolve({ done: true, value: undefined })
              if (queued.length) return Promise.resolve({ done: false, value: queued.shift() })
              return new Promise((resolve) => {
                const waiter = { resolve }
                waiters.push(waiter)
                signal?.addEventListener("abort", () => {
                  const index = waiters.indexOf(waiter)
                  if (index >= 0) waiters.splice(index, 1)
                  resolve({ done: true, value: undefined })
                }, { once: true })
              })
            },
          }
        },
      },
    },
    hooks,
    prompts,
    rememberUser,
    async emitEvent(event) {
      const waiter = waiters.shift()
      if (waiter) waiter.resolve({ done: false, value: event })
      else queued.push(event)
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
  }
  return host
}

async function waitForValue(predicate, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${message}`)
}

async function runContext(host, sessionID, messageID) {
  const hook = host.hooks.get("context")
  assert.equal(typeof hook, "function")
  const event = {
    sessionID,
    agent: "build",
    system: ["base system"],
    tools: {
      opencode_goals_v2_control: {},
      opencode_goals_v2_get: {},
      opencode_goal_resume: {},
    },
    messages: [{
      id: messageID,
      role: "user",
      content: "host-admitted Goal continuation",
    }],
  }
  await hook(event)
}

async function withAutonomousPreview(fn) {
  const directKey = OPENCODE2_DIRECT_LIFECYCLE_ENV
  const autonomousKey = OPENCODE2_AUTONOMOUS_ENV
  const previousDirect = process.env[directKey]
  const previousAutonomous = process.env[autonomousKey]
  process.env[directKey] = "1"
  process.env[autonomousKey] = "1"
  try {
    return await fn()
  } finally {
    if (previousDirect === undefined) delete process.env[directKey]
    else process.env[directKey] = previousDirect
    if (previousAutonomous === undefined) delete process.env[autonomousKey]
    else process.env[autonomousKey] = previousAutonomous
  }
}

async function admitGoalOwnedCompactionTurn(host, sessionID) {
  await host.emitEvent({ type: "session.compaction.started", data: { sessionID } })
  await host.emitEvent({ type: "session.compaction.ended", data: { sessionID } })
  await host.emitEvent({ type: "session.execution.succeeded", data: { sessionID } })
  return await waitForValue(
    () => host.prompts.find((item) =>
      item.resume === false
      && item.metadata?.opencode_goal_v2_source === "compaction"
    ),
    "Goal-owned compaction continuation admission",
  )
}

test("V2 terminal recovers lost Goal execution ownership from persisted session context exactly once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "goal-v2-persisted-owner-"))
  try {
    await withAutonomousPreview(async () => {
      const host = fakeV2EventContext(root)
      const sessionID = "v2-persisted-owner"
      const store = new GoalStore(root)
      await store.save(createGoal({ sessionID, objective: "recover persisted V2 ownership" }))

      let cleanup = await OpenCode2GoalsExperimental.setup(host.ctx)
      try {
        const owned = await admitGoalOwnedCompactionTurn(host, sessionID)
        await runContext(host, sessionID, owned.returnedID)
        await host.emitEvent({ type: "session.execution.started", data: { sessionID } })

        await cleanup()
        cleanup = await OpenCode2GoalsExperimental.setup(host.ctx)

        await host.emitEvent({ type: "session.execution.succeeded", data: { sessionID } })
        const recovered = await waitForValue(
          () => host.prompts.find((item) =>
            item.resume === false
            && item.returnedID !== owned.returnedID
            && item.metadata?.opencode_goal_v2_source === "execution"
          ),
          "recovered Goal continuation after runtime ownership loss",
        )
        assert.ok(recovered.returnedID)

        const persisted = await waitForValue(async () => {
          const goal = await store.load(sessionID)
          return goal?.stalledTurns === 1 ? goal : undefined
        }, "one settled Goal turn after persisted ownership recovery")
        assert.equal(persisted.status, "active")

        const beforeReplay = host.prompts.filter((item) =>
          item.resume === false
          && item.metadata?.opencode_goal_v2_autonomous === true
        ).length
        await host.emitEvent({ type: "session.execution.succeeded", data: { sessionID } })
        await new Promise((resolve) => setTimeout(resolve, 25))
        assert.equal(
          host.prompts.filter((item) =>
            item.resume === false
            && item.metadata?.opencode_goal_v2_autonomous === true
          ).length,
          beforeReplay,
          "replayed terminal generation must not dispatch another Goal continuation",
        )
        assert.equal((await store.load(sessionID)).stalledTurns, 1)
      } finally {
        await cleanup()
      }
    })
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test("V2 persisted ownership recovery fails closed when a newer ordinary user message exists", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "goal-v2-persisted-owner-steer-"))
  try {
    await withAutonomousPreview(async () => {
      const host = fakeV2EventContext(root)
      const sessionID = "v2-persisted-owner-steer"
      const store = new GoalStore(root)
      await store.save(createGoal({ sessionID, objective: "respect foreground steering" }))

      let cleanup = await OpenCode2GoalsExperimental.setup(host.ctx)
      try {
        const owned = await admitGoalOwnedCompactionTurn(host, sessionID)
        await runContext(host, sessionID, owned.returnedID)
        await host.emitEvent({ type: "session.execution.started", data: { sessionID } })

        await cleanup()
        cleanup = await OpenCode2GoalsExperimental.setup(host.ctx)
        host.rememberUser(sessionID, "ordinary-user-after-restart", "stop and inspect", {})

        const admissionsBefore = host.prompts.filter((item) =>
          item.resume === false
          && item.metadata?.opencode_goal_v2_autonomous === true
        ).length
        await host.emitEvent({ type: "session.execution.succeeded", data: { sessionID } })
        await new Promise((resolve) => setTimeout(resolve, 25))

        assert.equal(
          host.prompts.filter((item) =>
            item.resume === false
            && item.metadata?.opencode_goal_v2_autonomous === true
          ).length,
          admissionsBefore,
          "ordinary foreground steering must block persisted-owner fallback",
        )
        assert.equal((await store.load(sessionID)).stalledTurns, 0)
      } finally {
        await cleanup()
      }
    })
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})
