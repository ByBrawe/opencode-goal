import OpenCodeGoalCorePlugin from "./opencode/plugin.js"
import { enhanceGoalControls } from "./opencode/controls.js"
import { installHostLimitHandling } from "./opencode/host-limits.js"
import { captureStartupGoals, scheduleStartupRecovery } from "./opencode/recovery.js"

export default async function OpenCodeGoalPlugin(input: Parameters<typeof OpenCodeGoalCorePlugin>[0]) {
  // Snapshot only goals that existed before this plugin instance loaded. This
  // prevents startup recovery from racing with a brand-new /goal created by
  // the same host instance.
  const startupGoals = await captureStartupGoals(input.directory)
  const hooks = await OpenCodeGoalCorePlugin(input)
  enhanceGoalControls(input, hooks)
  installHostLimitHandling(input, hooks)
  scheduleStartupRecovery(input, hooks, startupGoals)
  return hooks
}

export * from "./domain/types.js"
export * from "./domain/goal.js"
export * from "./verification/audit.js"
export * from "./verification/evidence.js"
export * from "./runtime/accounting.js"
export * from "./runtime/blocker.js"
export * from "./runtime/limits.js"
export * from "./runtime/progress.js"
export * from "./opencode/command.js"
