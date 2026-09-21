import type { PluginModule } from "@opencode-ai/plugin"
import OpenCodeGoalPlugin from "./index.js"
import OpenCode2GoalsExperimental from "./opencode2/experimental.js"

const plugin = {
  id: "@bybrawe/opencode-goal",

  // OpenCode 1.x server-plugin contract.
  server: OpenCodeGoalPlugin,

  // OpenCode 2.x promise-plugin contract. The V2 adapter intentionally
  // remains read-only until its host safety gates are satisfied.
  setup: OpenCode2GoalsExperimental.setup,
} satisfies PluginModule & {
  id: string
  setup: typeof OpenCode2GoalsExperimental.setup
}

export default plugin
