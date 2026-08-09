import type { GoalState } from "../domain/types.js"

function constraintBlock(goal: GoalState): string {
  const constraints = goal.constraints ?? []
  if (!constraints.length) return "- none declared"
  return constraints.map((item) => `- ${item}`).join("\n")
}

export function continuationPrompt(goal: GoalState): string {
  const requirementLines = goal.requirements.map((item, index) => `${index + 1}. [${item.status}] ${item.text}`).join("\n")
  return `Continue working toward the active OpenCode goal.\n\n<objective>\n${goal.objective}\n</objective>\n\n<goal_constraints>\n${constraintBlock(goal)}\n</goal_constraints>\n\nRequirements:\n${requirementLines}\n\nGoal rules:\n- Preserve the full objective. Do not redefine success around a smaller task.\n- Treat every declared constraint/non-goal as a hard boundary. Do not trade it away to satisfy a narrower success criterion.\n- Work from the current worktree and external state, not memory alone.\n- Make concrete progress before narrating progress.\n- Agent-written notes are not completion evidence. Use host-verifying goal tools when evidence can be checked.\n- Do not claim completion until every required item, including every constraint requirement, is proven by current trusted evidence.\n- If configured checks exist, the plugin will run them during completion audit.\n- A blocker must be a real impasse. The same blocker must persist across three distinct goal turns before the plugin will stop as blocked.\n- User messages override autonomous continuation.\n\nBudget used: turns=${goal.usage.turns}/${goal.budget.maxTurns || "unbounded"}, tokens=${goal.usage.tokens}/${goal.budget.maxTokens || "unbounded"}, cost=${goal.usage.cost.toFixed(4)}/${goal.budget.maxCost || "unbounded"}.\n\nUse opencode_goal_progress for a checkpoint, opencode_goal_evidence_file for host-checked file evidence, opencode_goal_complete when the goal is actually proven complete, or opencode_goal_blocked only for a genuine repeated blocker.`
}

export function compactionContext(goal: GoalState): string {
  return `Persistent OpenCode goal state:\nObjective: ${goal.objective}\nStatus: ${goal.status}\nRevision: ${goal.revision}\nConstraints / non-goals:\n${constraintBlock(goal)}\nRequirements:\n${goal.requirements.map((r) => `- [${r.status}] ${r.text}`).join("\n")}\nUsage: ${goal.usage.turns} turns, ${goal.usage.tokens} tokens, cost ${goal.usage.cost.toFixed(4)}.\nThis state is persisted by the goal plugin and is authoritative across compaction.`
}
