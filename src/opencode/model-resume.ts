import { tool } from "@opencode-ai/plugin/tool"
import type CorePlugin from "./plugin.js"
import { resumeGoal } from "../domain/goal.js"
import { GoalStore, GoalStoreIntegrityError } from "../persistence/store.js"

type PluginInput = Parameters<typeof CorePlugin>[0]
type PluginHooks = Awaited<ReturnType<typeof CorePlugin>>

function concise(value: string, max = 600): string {
  const text = value.replace(/\s+/g, " ").trim()
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function pausedAgentInstruction(goal: { id?: string; revision?: number; objective: string; stopReason?: string }): string {
  return [
    "OpenCode Goal state: a persisted Goal is currently paused.",
    `Goal: ${goal.id ?? "current"} revision ${goal.revision ?? "unknown"}.`,
    `Goal objective preview: ${concise(goal.objective)}.`,
    `Pause reason: ${concise(goal.stopReason ?? "not specified", 300)}`,
    "Decide from the latest user's meaning, in whatever language they used, whether they want to resume/continue/steer this Goal.",
    "If they do, call opencode_goal_resume before attempting Goal work.",
    "If they are only asking a question, requesting status/explanation, or discussing unrelated work, do not call the resume tool.",
    "Do not use exact-word or language-specific phrase matching; interpret the user's intent normally.",
  ].join("\n")
}

/**
 * Keep natural-language intent inside the agent/model layer. Lifecycle code owns
 * deterministic state and command boundaries; the model decides whether a
 * foreground message means "resume" and invokes this tool when appropriate.
 *
 * The tool deliberately does not activate the Goal in the middle of the model's
 * routing turn. It records an in-memory resume request, then the event wrapper
 * activates the persisted Goal exactly at the following session.idle boundary.
 * Core Goal scheduling can then seed normal prompt ownership before any project
 * work is attempted. If the process dies before idle, the Goal remains safely
 * paused and the user can repeat the request.
 */
export function installGoalModelResume(input: PluginInput, hooks: PluginHooks): void {
  const store = new GoalStore(input.directory)
  const systemHook = (hooks as any)["experimental.chat.system.transform"]
  const eventHook = hooks.event
  const pendingResume = new Set<string>()

  ;(hooks as any)["experimental.chat.system.transform"] = async (event: any, output: any) => {
    if (typeof systemHook === "function") await systemHook(event, output)

    let goal
    try {
      goal = await store.load(event.sessionID)
    } catch (error) {
      if (error instanceof GoalStoreIntegrityError) return
      throw error
    }
    if (!goal || goal.status !== "paused") return

    const instruction = pausedAgentInstruction(goal)
    if (!Array.isArray(output?.system)) return
    if (output.system.length === 0) output.system.push(instruction)
    else output.system[0] = `${output.system[0]}\n\n${instruction}`
  }

  if (typeof eventHook === "function") {
    hooks.event = async (inputEvent: any) => {
      const event = inputEvent?.event
      const type = String(event?.type ?? "")
      const properties = event?.properties ?? {}
      const sessionID = properties.sessionID ?? properties.info?.sessionID ?? properties.part?.sessionID

      if (type === "session.idle" && typeof sessionID === "string" && pendingResume.delete(sessionID)) {
        let goal
        try {
          goal = await store.load(sessionID)
        } catch (error) {
          if (!(error instanceof GoalStoreIntegrityError)) throw error
        }

        if (goal?.status === "paused") {
          await store.save({
            ...resumeGoal(goal),
            // The just-finished assistant turn only routed natural-language
            // intent to this control tool; it was not a Goal-owned work turn.
            // Exempt that idle boundary, then let core dispatch real ownership.
            skipNextStallCheck: true,
          })
        }
      }

      await eventHook(inputEvent)
    }
  }

  // Core returns a structurally inferred object with its built-in Goal tool
  // names as literal keys. OpenCode's runtime tool registry is extensible, so
  // widen only this local view instead of weakening the core plugin's types.
  const tools = (hooks as any).tool as Record<string, any> | undefined
  if (!tools || tools.opencode_goal_resume) return

  tools.opencode_goal_resume = tool({
    description: [
      "Resume the current persisted OpenCode Goal when the latest user message semantically asks to continue, resume, proceed, or steer that paused Goal.",
      "Interpret the user's meaning directly in any language; do not rely on exact phrases.",
      "Do not call this tool for status/explanation questions or unrelated conversation.",
      "After a successful call, end the current assistant turn without project mutations; Goal-owned work is activated and dispatched at session idle.",
    ].join(" "),
    args: {},
    execute: async (_args: any, context: any) => {
      let goal
      try {
        goal = await store.load(context.sessionID)
      } catch (error) {
        if (error instanceof GoalStoreIntegrityError) return "Goal resume rejected: persisted Goal state failed integrity validation."
        throw error
      }

      if (!goal) return "Goal resume not needed: no persisted Goal exists."
      if (goal.status === "active") return "Goal resume not needed: the Goal is already active."
      if (goal.status !== "paused") {
        return `Goal resume rejected: current Goal status is ${goal.status}. Use the appropriate Goal control instead.`
      }

      pendingResume.add(context.sessionID)
      return [
        "Goal resume accepted from the user's natural-language intent.",
        `Goal ${goal.id} revision ${goal.revision} remains paused until the idle ownership boundary.`,
        "End this assistant turn without modifying the project. At session idle, OpenCode Goal will activate the Goal and dispatch the normal owned continuation turn.",
      ].join("\n")
    },
  })
}
