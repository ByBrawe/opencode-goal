import type CorePlugin from "./plugin.js"
import { isGoalControlPlanePath } from "../runtime/control-plane-path.js"

type PluginInput = Parameters<typeof CorePlugin>[0]
type PluginHooks = Awaited<ReturnType<typeof CorePlugin>>

/**
 * Filter OpenCode PatchPart events before the core Goal adapter sees them.
 *
 * GoalStore persists below `.opencode/goals` (plus lock/sequence siblings).
 * OpenCode can report those atomic persistence writes as workspace patches.
 * They are control-plane churn, not project progress, and must never reset the
 * no-progress/stall guard. Mixed patches retain only real project paths.
 */
export function installGoalControlPlaneProgressGuard(_input: PluginInput, hooks: PluginHooks): void {
  const eventHook = hooks.event
  if (typeof eventHook !== "function") return

  hooks.event = async (input: any) => {
    const event = input?.event
    const properties = event?.properties ?? {}
    const part = properties.part
    if (event?.type !== "message.part.updated" || part?.type !== "patch" || !Array.isArray(part.files) || part.files.length === 0) {
      await eventHook(input)
      return
    }

    const files = part.files.map(String)
    const projectFiles = files.filter((file) => !isGoalControlPlanePath(file))
    if (projectFiles.length === 0) return
    if (projectFiles.length === files.length) {
      await eventHook(input)
      return
    }

    await eventHook({
      ...input,
      event: {
        ...event,
        properties: {
          ...properties,
          part: { ...part, files: projectFiles },
        },
      },
    })
  }
}
