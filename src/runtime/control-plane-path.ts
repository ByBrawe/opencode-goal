const CONTROL_PLANE_ROOTS = [
  ".opencode/goals",
  ".opencode/goal-locks",
  ".opencode/goal-sequences",
] as const

function normalizedPath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/\/{2,}/g, "/").toLowerCase()
}

/**
 * Goal persistence is implementation/control-plane state, not user project work.
 *
 * OpenCode may surface atomic GoalStore writes as PatchPart workspace changes.
 * Counting those files as host progress creates a feedback loop where every
 * Goal state save appears to prove fresh coding progress and defeats the stall
 * guard. Keep this narrow: other project-owned `.opencode/*` files (for example
 * commands) can still be legitimate work.
 */
export function isGoalControlPlanePath(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false
  const path = normalizedPath(value)
  return CONTROL_PLANE_ROOTS.some((root) => (
    path === root
    || path.startsWith(`${root}/`)
    || path.endsWith(`/${root}`)
    || path.includes(`/${root}/`)
  ))
}
