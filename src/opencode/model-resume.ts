import { tool } from "@opencode-ai/plugin/tool"
import type CorePlugin from "./plugin.js"
import { resumeGoal } from "../domain/goal.js"
import { GoalStore, GoalStoreConcurrencyError, GoalStoreIntegrityError } from "../persistence/store.js"

type PluginInput = Parameters<typeof CorePlugin>[0]
type PluginHooks = Awaited<ReturnType<typeof CorePlugin>>

function pausedAgentInstruction(goal: { objective: string; stopReason?: string }): string {
  return [
    "OpenCode Goal state: a persisted Goal is currently paused.",
    `Goal objective: ${goal.objective}`,
    `Pause reason: ${goal.stopReason ?? "not specified"}`,
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
 * The tool only activates the Goal and exempts the current foreground response
 * from no-progress accounting. Actual Goal-owned work starts at the following
 * session.idle continuation, so normal Goal prompt ownership remains intact.
 */
export function installGoalModelResume(input: PluginInput, hooks: PluginHooks): void {
  const store = new GoalStore(input.directory)
  const systemHook = (hooks as any)["experimental.chat.system.transform"]

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
      "After a successful call, end the current assistant turn without project mutations; Goal-owned work is dispatched on session idle.",
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

      const resumed = {
        ...resumeGoal(goal),
        // This foreground assistant response is the semantic routing turn, not
        // a Goal-owned continuation turn. Do not count its idle boundary as a
        // fresh no-progress failure before the scheduler dispatches ownership.
        skipNextStallCheck: true,
      }

      try {
        await store.save(resumed)
      } catch (error) {
        if (error instanceof GoalStoreConcurrencyError) {
          return "Goal resume not applied: Goal state changed concurrently. Re-read the Goal and reassess the user's request."
        }
        throw error
      }

      return [
        "Goal resumed from the user's natural-language intent.",
        `Objective: ${resumed.objective}`,
        "End this assistant turn without modifying the project. On session idle, OpenCode Goal will dispatch the normal owned continuation turn and continue the work there.",
      ].join("\n")
    },
  })
}
