import type { PluginModule } from "@opencode-ai/plugin"
import OpenCodeGoalPlugin from "./index.js"
import OpenCode2GoalsExperimental from "./opencode2/experimental.js"

const plugin = {
  id: "@bybrawe/opencode-goal",

  // OpenCode 1.x server-plugin contract.
  server: OpenCodeGoalPlugin,

  // OpenCode 2.x promise-plugin contract. The implementation module keeps
  // its historical name, but the V2 lifecycle/autonomous path is stable by
  // default; its environment flags remain explicit fail-closed kill switches.
  setup: OpenCode2GoalsExperimental.setup,
} satisfies PluginModule & {
  id: string
  setup: typeof OpenCode2GoalsExperimental.setup
}

export default plugin
