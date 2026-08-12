import OpenCodeGoalCorePlugin from "./opencode/plugin.js"
import { enhanceGoalControls } from "./opencode/controls.js"
import { installGoalAuditUX } from "./opencode/audit-ux.js"
import { installProjectGoalIndex } from "./opencode/project-index.js"
import { installGoalContractUX } from "./opencode/contract-ux.js"
import { installGoalTodoOrchestration } from "./opencode/todo-orchestration.js"
import { installGoalSequence } from "./opencode/sequence.js"
import { installTaskDeferral } from "./opencode/task-deferral.js"
import { installRestrictedAgentSafety } from "./opencode/agent-boundary.js"
import { installHostLimitHandling } from "./opencode/host-limits.js"
import { captureStartupGoals, scheduleStartupRecovery } from "./opencode/recovery.js"

export default async function OpenCodeGoalPlugin(
  input: Parameters<typeof OpenCodeGoalCorePlugin>[0],
  options: Parameters<typeof OpenCodeGoalCorePlugin>[1] = {},
) {
  // Snapshot only goals that existed before this plugin instance loaded. This
  // prevents startup recovery from racing with a brand-new /goal created by
  // the same host instance.
  const startupGoals = await captureStartupGoals(input.directory)
  const hooks = await OpenCodeGoalCorePlugin(input, options)
  enhanceGoalControls(input, hooks)
  installGoalAuditUX(input, hooks)
  installProjectGoalIndex(input, hooks)
  installGoalContractUX(input, hooks)
  // Native OpenCode Todos remain execution-planning state. The bridge records
  // only current-revision aggregate telemetry and never turns Todo status into
  // Goal completion evidence.
  installGoalTodoOrchestration(input, hooks)
  // Ordered Goals stay below task/Plan wrappers. Parent task deferral and the
  // restricted-agent boundary therefore win before a sequence idle can advance.
  installGoalSequence(input, hooks)
  // Task deferral sits below the restricted-agent wrapper so Plan safety always
  // wins before a delegated-task idle suppression decision is made.
  installTaskDeferral(input, hooks)
  installRestrictedAgentSafety(input, hooks)
  installHostLimitHandling(input, hooks)
  scheduleStartupRecovery(input, hooks, startupGoals)
  return hooks
}

export * from "./domain/types.js"
export * from "./domain/goal.js"
export * from "./domain/sequence.js"
export * from "./verification/audit.js"
export * from "./verification/evidence.js"
export * from "./runtime/accounting.js"
export * from "./runtime/blocker.js"
export * from "./runtime/limits.js"
export * from "./runtime/model-context.js"
export * from "./runtime/progress.js"
export * from "./runtime/todo-plan.js"
export * from "./persistence/sequence-store.js"
export * from "./opencode/command.js"
export * from "./opencode/audit-ux.js"
export * from "./opencode/agent-boundary.js"
export * from "./opencode/task-deferral.js"
export * from "./opencode/project-index.js"
export * from "./opencode/sequence.js"
export * from "./opencode/todo-orchestration.js"
