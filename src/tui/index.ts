import { Plugin } from '@opencode/plugin/tui'
import type { GoalTuiContext } from './native.js'

const native = Plugin.define({
  id: 'opencode-goal',
  async setup(context) {
    const { setupNativeGoalTui } = await import('./native.js')
    return setupNativeGoalTui(context as GoalTuiContext)
  },
})

// Keep the V1 TUI implementation isolated behind its legacy entrypoint.
// V2 consumes only the Plugin.define() id/setup contract.
const plugin = {
  ...native,
  async tui(...args: Parameters<typeof import('./legacy-v1.js').default.tui>) {
    const { default: legacy } = await import('./legacy-v1.js')
    return legacy.tui(...args)
  },
}

export default plugin
