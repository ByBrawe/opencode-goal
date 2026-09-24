import { appendFile } from "node:fs/promises"
import path from "node:path"
import { GoalStore } from "../dist/persistence/store.js"
import { openCode2ExecutionSessionID } from "../dist/opencode2/execution-boundary.js"
import { prepareOpenCode2Continuation } from "../dist/opencode2/continuation-boundary.js"
import { prepareOpenCode2RestartContinuation } from "../dist/opencode2/restart-boundary.js"
import {
  createOpenCode2CompactionBoundaryRuntime,
  observeOpenCode2CompactionBoundary,
  prepareOpenCode2PostCompactionContinuation,
} from "../dist/opencode2/compaction-boundary.js"

const traceFile = process.env.OPENCODE_GOAL_V2_RUNTIME_TRACE
const restartSessionID = process.env.OPENCODE_GOAL_V2_RUNTIME_RESTART_SESSION

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
    const compactionBoundary = createOpenCode2CompactionBoundaryRuntime()

    const scheduleContinuation = async (sessionID, prompt, source, stalledTurns) => {
      if (dispatching.has(sessionID)) {
        await trace({ phase: "goal.continuation.skipped", sessionID, source, reason: "dispatch-in-flight" })
        return
      }
      if (typeof ctx.session.prompt !== "function") {
        await trace({ phase: "goal.continuation.error", sessionID, source, error: "session.prompt unavailable" })
        return
      }

      dispatching.add(sessionID)
      await trace({ phase: "goal.continuation.scheduled", sessionID, source, stalledTurns })
      queueMicrotask(() => {
        Promise.resolve(ctx.session.prompt({
          sessionID,
          text: prompt,
          delivery: "steer",
          resume: true,
          metadata: {
            opencode_goal_v2_runtime_canary_continuation: true,
            opencode_goal_v2_runtime_canary_source: source,
          },
        }))
          .then(async () => {
            await trace({ phase: "goal.continuation.dispatched", sessionID, source, stalledTurns })
          })
          .catch(async (error) => {
            await trace({
              phase: "goal.continuation.error",
              sessionID,
              source,
              error: String(error?.stack || error),
            })
          })
          .finally(() => dispatching.delete(sessionID))
      })
    }

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

          const compaction = observeOpenCode2CompactionBoundary(compactionBoundary, event)
          if (compaction.recognized && sessionID) {
            await trace({
              phase: "goal.compaction.boundary",
              sessionID,
              type: event?.type,
              consumedExecution: compaction.consumedExecution,
              compactionCompleted: compaction.compactionCompleted,
              compactionFailed: compaction.compactionFailed,
            })
          }

          if (compaction.compactionCompleted && sessionID) {
            try {
              const directory = await resolveSessionDirectory(ctx, sessionID)
              const store = directory ? new GoalStore(directory) : null
              const goal = store ? await store.load(sessionID) : null
              if (!goal) {
                await trace({ phase: "goal.compaction.continuation.skipped", sessionID, reason: "missing-goal" })
              } else {
                const prepared = prepareOpenCode2PostCompactionContinuation(goal)
                await trace({
                  phase: "goal.compaction.continuation.ready",
                  sessionID,
                  status: goal.status,
                  stalledTurns: goal.stalledTurns,
                  progressRevision: goal.progressRevision,
                  observedProgressRevision: goal.observedProgressRevision,
                  shouldContinue: prepared.shouldContinue,
                })
                if (prepared.shouldContinue && prepared.prompt) {
                  await scheduleContinuation(sessionID, prepared.prompt, "compaction", goal.stalledTurns)
                }
              }
            } catch (error) {
              await trace({
                phase: "goal.compaction.continuation.error",
                sessionID,
                error: String(error?.stack || error),
              })
            }
          }

          if (compaction.consumedExecution) continue
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
            await scheduleContinuation(
              sessionID,
              prepared.prompt,
              "execution",
              prepared.goal.stalledTurns,
            )
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

    let restartTimer
    if (restartSessionID) {
      restartTimer = setTimeout(() => {
        void (async () => {
          try {
            const directory = await resolveSessionDirectory(ctx, restartSessionID)
            const store = directory ? new GoalStore(directory) : null
            const goal = store ? await store.load(restartSessionID) : null
            if (!goal) {
              await trace({ phase: "goal.restart.continuation.skipped", sessionID: restartSessionID, reason: "missing-goal" })
              return
            }

            const prepared = prepareOpenCode2RestartContinuation(goal)
            await trace({
              phase: "goal.restart.continuation.ready",
              sessionID: restartSessionID,
              status: goal.status,
              stalledTurns: goal.stalledTurns,
              progressRevision: goal.progressRevision,
              observedProgressRevision: goal.observedProgressRevision,
              shouldContinue: prepared.shouldContinue,
              blockedBy: prepared.blockedBy,
            })
            if (prepared.shouldContinue && prepared.prompt) {
              await scheduleContinuation(
                restartSessionID,
                prepared.prompt,
                "restart",
                goal.stalledTurns,
              )
            }
          } catch (error) {
            await trace({
              phase: "goal.restart.continuation.error",
              sessionID: restartSessionID,
              error: String(error?.stack || error),
            })
          }
        })()
      }, 0)
      restartTimer.unref?.()
    }

    return async () => {
      if (restartTimer) clearTimeout(restartTimer)
      controller.abort()
      await eventTask.catch(() => {})
      await compactionRegistration?.dispose?.()
      await contextRegistration?.dispose?.()
    }
  },
}
