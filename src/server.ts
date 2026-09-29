import type { PluginModule } from "@opencode-ai/plugin"
import OpenCodeGoalPlugin from "./legacy-loader.js"
import { setupNativeGoals } from "./opencode2/native-setup.js"

const plugin = {
  id: "@bybrawe/opencode-goal",

  // OpenCode 1.x server-plugin contract.
  server: OpenCodeGoalPlugin,

  // OpenCode 2.x promise-plugin contract. The implementation module keeps
  // its historical name, but the V2 lifecycle/autonomous path is stable by
  // default; its environment flags remain explicit fail-closed kill switches.
  setup: setupNativeGoals,
} satisfies PluginModule & {
  id: string
  setup: typeof setupNativeGoals
}

export default plugin
