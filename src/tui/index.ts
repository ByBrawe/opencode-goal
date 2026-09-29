import type { GoalTuiContext } from './native.js'

// Importing the published TUI entry is safe in a production-only Node
// consumer. UI peers and the legacy filesystem view are both lazy.
const plugin = {
  id: 'opencode-goal',
  async setup(context: GoalTuiContext) {
    const { setupNativeGoalTui } = await import('./native.js')
    return setupNativeGoalTui(context)
  },
  async tui(...args: Parameters<typeof import('./legacy-v1.js').default.tui>) {
    const { default: legacy } = await import('./legacy-v1.js')
    return legacy.tui(...args)
  },
}
export default plugin
