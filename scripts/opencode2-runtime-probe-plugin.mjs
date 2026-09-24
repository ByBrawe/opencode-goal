import { appendFile } from "node:fs/promises"
import path from "node:path"
import { GoalStore } from "../dist/persistence/store.js"
import { openCode2ExecutionSessionID } from "../dist/opencode2/execution-boundary.js"
import { prepareOpenCode2Continuation } from "../dist/opencode2/continuation-boundary.js"

const traceFile = process.env.OPENCODE_GOAL_V2_RUNTIME_TRACE

async function trace(event) {
  if (!traceFile) return
  await appendFile(traceFile, JSON.stringify({ at: Date.now(), ...event }) + "\n", "utf8")
}

function record(value) {
  return value && typeof value === "object" ? value : undefined
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

function eventStatus(event) {
  return event?.properties?.status ?? event?.data?.status ?? event?.status
}

async function resolveSessionDirectory(ctx, sessionID) {
  let session
  try {
    session = await ctx.session.get({ sessionID })
  } catch {
    session = undefined
  }
  const data = record(session?.data)
  const location = record(session?.location) ?? record(data?.location)
  const directory = firstString(location?.directory, session?.directory, data?.directory, ctx.options?.directory)
  return directory ? path.resolve(directory) : undefined
}

export default {
  id: "bybrawe.opencode-goal.v2.runtime-capability-canary",
  async setup(ctx) {
    await trace({ phase: "setup" })

    const controller = new AbortController()
    const dispatching = new Set()
    const eventTask = (async () => {
      try {
        const events = ctx.event.subscribe({ signal: controller.signal })
        await trace({ phase: "event.subscribe.registered" })
        for await (const event of events) {
          const sessionID = openCode2ExecutionSessionID(event)
          await trace({
            phase: "event",
            type: event?.type,
            sessionID,
            status: eventStatus(event),
          })

          if (!sessionID || event?.type !== "session.execution.succeeded") continue
          try {
            const directory = await resolveSessionDirectory(ctx, sessionID)
            if (!directory) {
              await trace({ phase: "goal.execution.boundary.skipped", sessionID, reason: "missing-directory" })
              continue
            }

            const store = new GoalStore(directory)
            const goal = await store.load(sessionID)
            if (!goal) {
              await trace({ phase: "goal.execution.boundary.skipped", sessionID, reason: "missing-goal" })
              continue
            }

            const prepared = prepareOpenCode2Continuation(goal, event)
            if (!prepared.closed) {
              await trace({
                phase: "goal.execution.boundary.skipped",
                sessionID,
                reason: "not-successful-active-goal",
                status: goal.status,
              })
              continue
            }

            await store.save(prepared.goal)
            await trace({
              phase: "goal.execution.boundary.closed",
              sessionID,
              goalID: prepared.goal.id,
              status: prepared.goal.status,
              stalledTurns: prepared.goal.stalledTurns,
              progressRevision: prepared.goal.progressRevision,
              observedProgressRevision: prepared.goal.observedProgressRevision,
              shouldContinue: prepared.shouldContinue,
            })

            if (!prepared.shouldContinue || !prepared.prompt) continue
            if (dispatching.has(sessionID)) {
              await trace({ phase: "goal.continuation.skipped", sessionID, reason: "dispatch-in-flight" })
              continue
            }
            if (typeof ctx.session.prompt !== "function") {
              await trace({ phase: "goal.continuation.error", sessionID, error: "session.prompt unavailable" })
              continue
            }

            dispatching.add(sessionID)
            await trace({
              phase: "goal.continuation.scheduled",
              sessionID,
              stalledTurns: prepared.goal.stalledTurns,
            })
            queueMicrotask(() => {
              Promise.resolve(ctx.session.prompt({
                sessionID,
                text: prepared.prompt,
                delivery: "steer",
                resume: true,
                metadata: { opencode_goal_v2_runtime_canary_continuation: true },
              }))
                .then(async () => {
                  await trace({
                    phase: "goal.continuation.dispatched",
                    sessionID,
                    stalledTurns: prepared.goal.stalledTurns,
                  })
                })
                .catch(async (error) => {
                  await trace({
                    phase: "goal.continuation.error",
                    sessionID,
                    error: String(error?.stack || error),
                  })
                })
                .finally(() => dispatching.delete(sessionID))
            })
          } catch (error) {
            await trace({
              phase: "goal.execution.boundary.error",
              sessionID,
              error: String(error?.stack || error),
            })
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          await trace({ phase: "event.subscribe.error", error: String(error?.stack || error) })
        }
      }
    })()

    const contextRegistration = await ctx.session.hook("context", async (event) => {
      await trace({
        phase: "session.context",
        sessionID: event?.sessionID,
        agent: event?.agent,
        messageCount: Array.isArray(event?.messages) ? event.messages.length : 0,
      })
    })

    const compactionRegistration = await ctx.session.hook("compaction", async (event) => {
      await trace({
        phase: "session.compaction",
        sessionID: event?.sessionID,
        agent: event?.agent,
        messageCount: Array.isArray(event?.messages) ? event.messages.length : 0,
      })
    })
    await trace({ phase: "session.compaction.registered" })

    return async () => {
      controller.abort()
      await eventTask.catch(() => {})
      await compactionRegistration?.dispose?.()
      await contextRegistration?.dispose?.()
    }
  },
}
