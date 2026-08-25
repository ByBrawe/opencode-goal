import type CorePlugin from "./plugin.js"
import type { GoalState } from "../domain/types.js"
import { GoalStore, GoalStoreConcurrencyError } from "../persistence/store.js"
import {
  fatalProviderReason,
  hostUsageLimitReason,
  markPromptOverflowRecovering,
  markUsageLimited,
  pauseForFatalProviderError,
  providerPromptOverflowReason,
} from "../runtime/limits.js"
import { showGoalToast } from "./toast.js"

type PluginInput = Parameters<typeof CorePlugin>[0]
type PluginHooks = Awaited<ReturnType<typeof CorePlugin>>

type PromptOverflowAttempt = {
  goalID: string
  revision: number
  baselineTurns: number
}

type FreshMutationResult = {
  goal: GoalState
  wrote: boolean
}

function eventSessionID(input: any): string | undefined {
  const properties = input?.event?.properties ?? {}
  const value = properties.sessionID ?? properties.info?.sessionID ?? properties.part?.sessionID
  return typeof value === "string" && value ? value : undefined
}

function sameAttempt(goal: GoalState | null, attempt: PromptOverflowAttempt | undefined): goal is GoalState {
  return Boolean(goal && attempt && goal.id === attempt.goalID && goal.revision === attempt.revision)
}

async function abortSession(client: any, sessionID: string): Promise<void> {
  if (typeof client?.session?.abort !== "function") return
  try {
    await client.session.abort({ path: { id: sessionID } })
  } catch {
    // The provider error/retry may already have ended the run. State is still
    // authoritative and prevents the next idle from auto-continuing.
  }
}

function overflowFailureReason(reason: string): string {
  return `${reason} Automatic OpenCode compaction did not produce a successful Goal-owned turn. Goal state is preserved. Run /compact, then /goal resume.`
}

function clearOverflowRecovery(goal: GoalState, now = Date.now()): GoalState {
  const {
    infrastructureRecovery: _infrastructureRecovery,
    stopReason: _stopReason,
    skipNextStallCheck: _skipNextStallCheck,
    ...rest
  } = goal
  return { ...rest, status: "active", skipNextStallCheck: true, updatedAt: now }
}

/**
 * Host events and wrapper coordinators can persist the same Goal in adjacent
 * microtasks. Re-load and retry stale generation writes instead of allowing a
 * recovery transition to disappear or surface GoalStoreConcurrencyError.
 */
async function mutateFreshGoal(
  store: GoalStore,
  sessionID: string,
  mutate: (goal: GoalState) => GoalState | null,
  maxAttempts = 6,
): Promise<FreshMutationResult | null> {
  let lastStale: GoalStoreConcurrencyError | undefined
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const current = await store.load(sessionID)
    if (!current) return null
    const next = mutate(current)
    if (!next) return { goal: current, wrote: false }
    try {
      await store.save(next)
      return { goal: next, wrote: true }
    } catch (error) {
      if (error instanceof GoalStoreConcurrencyError && error.kind === "stale_write") {
        lastStale = error
        continue
      }
      throw error
    }
  }
  throw lastStale ?? new Error("Goal state kept changing while applying host-limit recovery")
}

export function installHostLimitHandling(input: PluginInput, hooks: PluginHooks): void {
  if (typeof hooks.event !== "function") return
  const originalEvent = hooks.event
  const store = new GoalStore(input.directory)
  const recoveringOverflow = new Set<string>()
  const overflowAttempts = new Map<string, PromptOverflowAttempt>()

  async function pauseOverflow(sessionID: string, attempt: PromptOverflowAttempt, reason: string): Promise<boolean> {
    const result = await mutateFreshGoal(store, sessionID, (latest) => {
      if (!sameAttempt(latest, attempt) || latest.status !== "active") return null
      return pauseForFatalProviderError(latest, overflowFailureReason(reason))
    })
    if (!result?.wrote) return false
    recoveringOverflow.delete(sessionID)
    await abortSession(input.client, sessionID)
    await showGoalToast(input.client, "Goal paused after the provider prompt stayed too large. Run /compact, then /goal resume.", "error")
    return true
  }

  async function recoverPromptOverflow(sessionID: string, attempt: PromptOverflowAttempt, reason: string): Promise<void> {
    const summarize = input.client?.session?.summarize
    const before = await store.load(sessionID)
    const model = sameAttempt(before, attempt) ? before.execution?.model : undefined
    if (typeof summarize !== "function" || !model) {
      recoveringOverflow.delete(sessionID)
      await pauseOverflow(sessionID, attempt, `${reason} Automatic compaction is unavailable for the bound OpenCode client/model.`)
      return
    }

    try {
      await summarize.call(input.client.session, {
        path: { id: sessionID },
        body: { providerID: model.providerID, modelID: model.modelID },
      })
    } catch (error) {
      recoveringOverflow.delete(sessionID)
      await pauseOverflow(sessionID, attempt, `${reason} Automatic compaction failed: ${String(error)}`)
      return
    }

    recoveringOverflow.delete(sessionID)
    const cleared = await mutateFreshGoal(store, sessionID, (latest) => {
      if (!sameAttempt(latest, attempt) || latest.status !== "active") return null
      return clearOverflowRecovery(latest)
    })
    if (!cleared?.wrote) return

    await showGoalToast(input.client, "Provider prompt limit reached; OpenCode compacted the session and Goal continuation is resuming.", "warning")

    // The compaction-continuation coordinator may have queued an idle while the
    // summarize request was in flight. Host-limit handling deliberately swallowed
    // those idles so the pre-compaction prompt could not race. Re-enter the final
    // wrapper stack once, after compaction is complete; its pending barrier (when
    // present) turns this into exactly one Goal-owned continuation.
    queueMicrotask(() => {
      const eventHook = hooks.event
      if (typeof eventHook !== "function") return
      void eventHook({ event: { type: "session.idle", properties: { sessionID } } }).catch(() => undefined)
    })
  }

  hooks.event = async (eventInput: any) => {
    const type = String(eventInput?.event?.type ?? "")
    const properties = eventInput?.event?.properties ?? {}
    const sessionID = eventSessionID(eventInput)

    if (sessionID && type === "session.idle" && recoveringOverflow.has(sessionID)) {
      // Never dispatch the oversized pre-compaction history again while the one
      // automatic compaction attempt is still in flight.
      return
    }

    if (sessionID && type === "session.status") {
      const reason = hostUsageLimitReason(properties.status)
      if (reason) {
        const limited = await mutateFreshGoal(store, sessionID, (goal) => goal.status === "active" ? markUsageLimited(goal, reason) : null)
        if (limited?.wrote) await abortSession(input.client, sessionID)
        await originalEvent(eventInput)
        return
      }
    }

    if (sessionID && type === "session.error") {
      const overflowReason = providerPromptOverflowReason(properties.error)
      if (overflowReason) {
        if (recoveringOverflow.has(sessionID)) {
          // Duplicate error delivery from the same failed request is not a
          // second compaction failure.
          await originalEvent(eventInput)
          return
        }

        const goal = await store.load(sessionID)
        if (goal?.status === "active") {
          const previous = overflowAttempts.get(sessionID)
          if (previous && sameAttempt(goal, previous) && goal.usage.turns <= previous.baselineTurns) {
            const paused = await mutateFreshGoal(store, sessionID, (latest) => {
              if (latest.status !== "active" || !sameAttempt(latest, previous) || latest.usage.turns > previous.baselineTurns) return null
              return pauseForFatalProviderError(latest, overflowFailureReason(overflowReason))
            })
            if (paused?.wrote) {
              recoveringOverflow.delete(sessionID)
              await abortSession(input.client, sessionID)
              await showGoalToast(input.client, "Goal paused after prompt overflow repeated. Run /compact, then /goal resume.", "error")
            }
          } else {
            recoveringOverflow.add(sessionID)
            let freshAttempt: PromptOverflowAttempt | undefined
            const marked = await mutateFreshGoal(store, sessionID, (latest) => {
              if (latest.status !== "active") return null
              freshAttempt = {
                goalID: latest.id,
                revision: latest.revision,
                baselineTurns: latest.usage.turns,
              }
              return markPromptOverflowRecovering(latest, overflowReason)
            })
            if (!marked?.wrote || !freshAttempt) {
              recoveringOverflow.delete(sessionID)
              await originalEvent(eventInput)
              return
            }

            overflowAttempts.set(sessionID, freshAttempt)
            await abortSession(input.client, sessionID)
            await showGoalToast(input.client, "Provider prompt limit reached; compacting the OpenCode session once before continuing.", "warning")
            await originalEvent(eventInput)
            const attempt = freshAttempt
            queueMicrotask(() => {
              void recoverPromptOverflow(sessionID, attempt, overflowReason).catch(async (error) => {
                recoveringOverflow.delete(sessionID)
                await pauseOverflow(sessionID, attempt, `${overflowReason} Automatic compaction recovery failed: ${String(error)}`).catch(() => undefined)
              })
            })
            return
          }
        }
        await originalEvent(eventInput)
        return
      }

      const reason = fatalProviderReason(properties.error)
      if (reason) {
        const paused = await mutateFreshGoal(store, sessionID, (goal) => goal.status === "active" ? pauseForFatalProviderError(goal, reason) : null)
        if (paused?.wrote) await abortSession(input.client, sessionID)
        await originalEvent(eventInput)
        return
      }
    }

    await originalEvent(eventInput)

    if (sessionID && type === "message.updated") {
      const info = properties.info
      const attempt = overflowAttempts.get(sessionID)
      if (!attempt || info?.role !== "assistant" || !info?.time?.completed || info?.summary === true) return
      const latest = await store.load(sessionID)
      if (!sameAttempt(latest, attempt) || latest.usage.turns > attempt.baselineTurns) {
        overflowAttempts.delete(sessionID)
      }
    }
  }
}
