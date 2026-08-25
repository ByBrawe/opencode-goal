import OpenCodeGoalCorePlugin from "./opencode/plugin.js"
import { installGoalControlPlaneProgressGuard } from "./opencode/control-plane-progress.js"
import { installForeignCommandSteeringGuard } from "./opencode/foreign-command-guard.js"
import { enhanceGoalControls } from "./opencode/controls.js"
import { installGoalAuditUX } from "./opencode/audit-ux.js"
import { installProjectGoalIndex } from "./opencode/project-index.js"
import { installGoalContractUX } from "./opencode/contract-ux.js"
import { installGoalTodoOrchestration } from "./opencode/todo-orchestration.js"
import { installGoalCompactionContinuation } from "./opencode/compaction-continuation.js"
import { installGoalSequence } from "./opencode/sequence.js"
import { installTaskDeferral } from "./opencode/task-deferral.js"
import { installShellProgress } from "./opencode/shell-progress.js"
import { installRestrictedAgentSafety } from "./opencode/agent-boundary.js"
import { installHostLimitHandling } from "./opencode/host-limits.js"
import { createGoalInfrastructureTransport, installGoalInfrastructureRecovery } from "./opencode/infrastructure-recovery.js"
import { preferSynchronousSessionPrompt } from "./opencode/client-compat.js"
import { installGoalModelResume } from "./opencode/model-resume.js"
import { installGoalLifecycleUX } from "./opencode/lifecycle-ux.js"
import { installGoalI18nUX } from "./opencode/i18n-ux.js"
import { captureStartupGoals, scheduleStartupRecovery } from "./opencode/recovery.js"
import { applySemanticVerifierTimeoutDefault } from "./opencode/verifier-defaults.js"

export default async function OpenCodeGoalPlugin(
  input: Parameters<typeof OpenCodeGoalCorePlugin>[0],
  options: Parameters<typeof OpenCodeGoalCorePlugin>[1] = {},
) {
  // Snapshot only goals that existed before this plugin instance loaded. This
  // prevents startup recovery from racing with a brand-new /goal created by
  // the same host instance.
  const startupGoals = await captureStartupGoals(input.directory)
  // Observe transient prompt transport failures before the core compatibility
  // proxy is applied. The observer never swallows errors; it only gives the
  // recovery coordinator a reliable signal after core cleanup has finished.
  const infrastructureTransport = createGoalInfrastructureTransport(input.client)
  const coreInput = {
    ...input,
    client: preferSynchronousSessionPrompt(infrastructureTransport.client),
  }
  const hooks = await OpenCodeGoalCorePlugin(coreInput, applySemanticVerifierTimeoutDefault(options))
  // GoalStore writes live inside the project tree and OpenCode may expose them
  // as PatchParts. Filter those control-plane paths directly above core before
  // they can be mistaken for user-project progress and reset the stall guard.
  installGoalControlPlaneProgressGuard(input, hooks)
  // OpenCode 1.x may still materialize a plugin-handled slash command as a
  // synthetic user/model turn. Install this directly above the core so outer
  // safety/deferral wrappers still run, while the core never mistakes that
  // command bridge for human Goal steering or a new execution context.
  installForeignCommandSteeringGuard(input, hooks)
  enhanceGoalControls(input, hooks)
  installGoalAuditUX(input, hooks)
  installProjectGoalIndex(input, hooks)
  installGoalContractUX(input, hooks)
  // Native OpenCode Todos remain execution-planning state. The bridge records
  // only current-revision aggregate telemetry and never turns Todo status into
  // Goal completion evidence.
  installGoalTodoOrchestration(input, hooks)
  // Own successful post-compaction wake-up before the sequence/task/safety
  // wrappers are installed. The coordinator routes its one-shot synthetic idle
  // through those outer wrappers, so their deferral/boundary rules still win.
  installGoalCompactionContinuation(input, hooks)
  // Ordered Goals stay below task/Plan wrappers. Parent task deferral and the
  // restricted-agent boundary therefore win before a sequence idle can advance.
  installGoalSequence(input, hooks)
  // Task deferral sits below the restricted-agent wrapper so Plan safety always
  // wins before a delegated-task idle suppression decision is made.
  installTaskDeferral(input, hooks)
  // Shell work can be the only durable work in a Goal turn (builds, generators,
  // capture pipelines, filesystem moves). Bind completed shell actions to the
  // current Goal revision so the no-progress guard does not misclassify them.
  installShellProgress(input, hooks)
  installRestrictedAgentSafety(input, hooks)
  installHostLimitHandling(input, hooks)
  // Infrastructure recovery sits outside host-limit classification but inside
  // lifecycle/i18n UX. Its synthetic wake-up is routed through the final hook
  // stack, so task/Plan/sequence/compaction ownership still remains authoritative.
  installGoalInfrastructureRecovery(input, hooks, infrastructureTransport)
  // Startup recovery uses the observed transport too: if the first prompt after
  // a process/network restart fails transiently, it enters the same persisted
  // backoff path instead of becoming a manual `/goal resume` dead-end.
  scheduleStartupRecovery({ ...input, client: infrastructureTransport.client }, hooks, startupGoals)
  // Natural-language continuation is an agent decision, not a lifecycle regex.
  // A paused Goal is exposed to the model with a dedicated resume tool; after
  // the model chooses it, normal session.idle dispatch restores Goal ownership.
  installGoalModelResume(input, hooks)
  // Lifecycle UX now owns only deterministic command/translation boundaries.
  // Localization is installed last and never rewrites foreground user intent.
  installGoalLifecycleUX(input, hooks)
  installGoalI18nUX(input, hooks)
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
export * from "./runtime/infrastructure-recovery.js"
export * from "./runtime/model-context.js"
export * from "./runtime/progress.js"
export * from "./runtime/todo-plan.js"
export * from "./runtime/control-plane-path.js"
export * from "./persistence/sequence-store.js"
export * from "./i18n.js"
export * from "./opencode/command.js"
export * from "./opencode/audit-ux.js"
export * from "./opencode/agent-boundary.js"
export * from "./opencode/task-deferral.js"
export * from "./opencode/shell-progress.js"
export * from "./opencode/project-index.js"
export * from "./opencode/sequence.js"
export * from "./opencode/todo-orchestration.js"
export * from "./opencode/compaction-continuation.js"
export * from "./opencode/infrastructure-recovery.js"
export * from "./opencode/client-compat.js"
export * from "./opencode/model-resume.js"
export * from "./opencode/control-plane-progress.js"
export * from "./opencode/lifecycle-ux.js"
export * from "./opencode/i18n-ux.js"
export * from "./opencode/verifier-defaults.js"
export * from "./opencode/foreign-command-guard.js"
